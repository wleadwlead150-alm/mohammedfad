"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const page = document.body.dataset.page || "";

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const formatDate = (value) => {
    if (!value) return "";
    try {
      return new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium" }).format(new Date(value));
    } catch {
      return "";
    }
  };

  const formatSize = (value) => {
    const size = Number(value);
    if (!size) return "ملف";
    return size >= 1024 * 1024
      ? `${(size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  };

  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      credentials: "include",
      ...options,
    });
    let data = null;
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      data = await response.json();
    }
    if (!response.ok) {
      throw new Error(data?.message || data?.error || `تعذر إكمال الطلب (${response.status})`);
    }
    return data;
  }

  async function uploadFormFiles(form, formData) {
    const selected = $$('input[type="file"]', form)
      .map((input) => ({ input, file: input.files?.[0] }))
      .filter(({ file }) => file && file.name);
    if (!selected.length) return;

    const mode = await api("/storage/mode");
    if (!mode.directUploadsEnabled) return;

    for (const { input, file } of selected) {
      const purpose = input.name;
      const request = await api("/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose,
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        }),
      });
      const uploaded = await fetch(request.uploadURL, {
        method: "PUT",
        credentials: "omit",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploaded.ok) {
        throw new Error("تعذر رفع الملف إلى التخزين الدائم. حاول مرة أخرى.");
      }
      formData.delete(input.name);
      formData.set(`${input.name}ObjectPath`, request.objectPath);
      formData.set(`${input.name}OriginalName`, file.name);
      formData.set(`${input.name}Size`, String(file.size));
    }
  }

  function setFormMessage(form, message) {
    const target =
      $(".form-msg", form) ||
      (form?.nextElementSibling?.classList.contains("form-msg")
        ? form.nextElementSibling
        : null);
    if (target) target.textContent = message || "";
  }

  function showState(host, message, isError = false) {
    if (!host) return;
    host.innerHTML = `<div class="list-state ${isError ? "error" : ""}">${escapeHtml(message)}${isError ? ' <button class="btn tiny" data-action="retry">إعادة المحاولة</button>' : ""}</div>`;
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeModals() {
    $$(".modal-backdrop").forEach((modal) => modal.classList.remove("open"));
    document.body.style.overflow = "";
  }

  if (page === "home") initHome();
  if (page === "course") initCourse();
  if (page === "admin") initAdmin();

  function initHome() {
    const state = {
      user: null,
      authMode: "login",
      courses: [],
      chatLoaded: false,
      subscription: null,
    };

    function canAccess(course) {
      return Boolean(course.isFree || state.user?.isSubscribed || state.user?.role === "admin");
    }

    function setAuthMode(mode) {
      state.authMode = mode;
      $("#auth-title").textContent = mode === "login" ? "مرحباً بعودتك" : "أنشئ حساب الطالب";
      $("#auth-submit").textContent = mode === "login" ? "تسجيل الدخول" : "إنشاء الحساب";
      $("#name-field").hidden = mode === "login";
      $("#auth-password").minLength = mode === "login" ? 1 : 8;
      $("#auth-switch-text").textContent =
        mode === "login" ? "ليس لديك حساب؟" : "لديك حساب بالفعل؟";
      $("#auth-name").required = mode === "register";
      $$("#auth-modal .form-msg").forEach((element) => (element.textContent = ""));
    }

    function renderCourses(courses) {
      state.courses = Array.isArray(courses) ? courses : [];
      const host = $("#course-list");
      if (!state.courses.length) {
        host.innerHTML = '<div class="empty-state">الدورات المنشورة ستظهر هنا عند توفرها.</div>';
        return;
      }
      host.innerHTML = `<div class="course-grid">${state.courses.map((course) => {
        const accessible = canAccess(course);
        const badge = course.isFree ? "مجاني" : accessible ? "متاح باشتراك" : "يتطلب اشتراكاً";
        const categories = {
          SMC: "SMC / ICT",
          ICT: "SMC / ICT",
        };
        const category = categories[course.category] || course.category || "مسار تعليمي";
        return `<a class="course-card" href="/course.html?id=${encodeURIComponent(course.id)}" data-course-id="${Number(course.id)}" data-category="${escapeHtml(category)}">
          <div class="meta"><span>${escapeHtml(category)}</span><span>${Number(course.lessonCount) || 0} درس</span></div>
          <h3>${escapeHtml(course.title)}</h3>
          <p>${escapeHtml(course.description || "تفاصيل الدورة والدروس المتاحة.")}</p>
          <div class="bottom"><span class="pill ${accessible ? "" : "locked"}">${badge}</span><span aria-hidden="true">${accessible ? "←" : "⌑"}</span></div>
        </a>`;
      }).join("")}</div>`;
    }

    async function loadCourses() {
      const host = $("#course-list");
      host.innerHTML = '<div class="loading-line"></div>';
      try {
        const data = await api("/courses");
        renderCourses(data.courses || []);
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function loadFiles(kind, targetSelector) {
      const host = $(targetSelector);
      try {
        const data = await api(`/files/${kind}`);
        const files = data.files || [];
        host.innerHTML = files.length
          ? files.map((file) => `<div class="file-row">
              <span>${escapeHtml(file.title)}<small>${escapeHtml(file.mimeType)} · ${formatSize(file.size)}</small></span>
              <a href="${escapeHtml(file.downloadUrl || `/api/files/${kind}/${file.id}/download`)}" target="_blank" rel="noopener">تنزيل ←</a>
            </div>`).join("")
          : '<div class="empty-state">لا توجد ملفات منشورة حالياً.</div>';
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function loadNews() {
      const host = $("#news-list");
      try {
        const data = await api("/news");
        host.innerHTML = data.news?.length
          ? data.news.map((news) => `<article class="insight">
              <time>${escapeHtml(news.category || "خبر")} · ${formatDate(news.createdAt)}</time>
              <h3>${escapeHtml(news.title)}</h3>
              <p>${escapeHtml(news.summary)}</p>
              ${news.sourceUrl ? `<a class="text-button" href="${escapeHtml(news.sourceUrl)}" target="_blank" rel="noopener">المصدر ←</a>` : ""}
            </article>`).join("")
          : '<div class="empty-state">لا توجد أخبار منشورة.</div>';
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function loadAnalyses() {
      const host = $("#analysis-list");
      try {
        const data = await api("/analyses");
        host.innerHTML = data.analyses?.length
          ? data.analyses.map((analysis) => `<article class="insight">
              <time>تحليل · ${formatDate(analysis.createdAt)}</time>
              <h3>${escapeHtml(analysis.title)}</h3>
              <p>${escapeHtml(analysis.body)}</p>
              ${analysis.attachmentPath ? `<a class="text-button" href="${escapeHtml(analysis.attachmentPath)}" target="_blank" rel="noopener">ملف التحليل ←</a>` : ""}
            </article>`).join("")
          : '<div class="empty-state">لا توجد تحليلات منشورة.</div>';
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function checkUser() {
      try {
        state.user = await api("/auth/me");
        try {
          const data = await api("/subscriptions");
          state.subscription = data.subscription || null;
          const target = $("#subscription-status");
          if (state.subscription) {
            const messages = {
              pending: "طلب اشتراكك قيد المراجعة.",
              approved: "اشتراكك معتمد — أهلاً بك في الدورات.",
              rejected: "تم رفض الطلب السابق. يمكنك إرسال طلب جديد.",
            };
            target.textContent = messages[state.subscription.status] || "لديك طلب اشتراك مسجل.";
            target.style.color =
              state.subscription.status === "approved" ? "var(--lime)" : "var(--orange)";
          }
        } catch (error) {
          $("#subscription-status").textContent = `تعذر تحميل حالة الاشتراك: ${error.message}`;
        }
        return state.user;
      } catch {
        state.user = null;
        return null;
      }
    }

    async function loadChat() {
      const host = $("#chat-messages");
      if (!state.user) {
        host.innerHTML = '<div class="empty-state">سجّل الدخول أولاً لبدء محادثة الدعم.</div>';
        $("#chat-status").textContent = "سجّل الدخول لبدء المحادثة";
        return;
      }
      host.innerHTML = '<div class="empty-state">جارٍ تحميل الرسائل…</div>';
      try {
        const data = await api("/messages");
        const messages = data.messages || [];
        host.innerHTML = messages.length
          ? messages.map((message) => `<div class="bubble ${message.senderRole === "student" ? "mine" : ""}">
              ${escapeHtml(message.body)}<small>${formatDate(message.createdAt)}</small>
            </div>`).join("")
          : '<div class="empty-state">ابدأ المحادثة برسالتك الأولى.</div>';
        host.scrollTop = host.scrollHeight;
        $("#chat-status").textContent = `متصل كـ ${state.user.name}`;
        state.chatLoaded = true;
      } catch (error) {
        host.innerHTML = `<div class="state error">${escapeHtml(error.message)}</div>`;
        $("#chat-status").textContent = "تعذر تحميل المحادثة";
      }
    }

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (button) {
        const action = button.dataset.action;
        if (action === "open-auth") {
          setAuthMode(button.dataset.mode || "login");
          openModal("auth-modal");
          return;
        }
        if (action === "auth-switch") {
          setAuthMode(state.authMode === "login" ? "register" : "login");
          return;
        }
        if (action === "open-subscription") {
          if (!state.user) {
            setAuthMode("login");
            openModal("auth-modal");
          } else {
            openModal("subscription-modal");
          }
          return;
        }
        if (action === "close-modal") {
          closeModals();
          return;
        }
        if (action === "menu") {
          $("#navlinks").classList.toggle("open");
          return;
        }
        if (action === "chat-toggle") {
          const panel = $("#chat-panel");
          if (!state.user) {
            setAuthMode("login");
            openModal("auth-modal");
            $("#chat-status").textContent = "سجّل الدخول أولاً";
            return;
          }
          panel.classList.toggle("open");
          if (panel.classList.contains("open") && !state.chatLoaded) await loadChat();
          return;
        }
        if (action === "chat-close") {
          $("#chat-panel").classList.remove("open");
          return;
        }
        if (action === "retry") {
          loadCourses();
          loadFiles("quizzes", "#quiz-files");
          loadFiles("results", "#result-files");
          loadNews();
          loadAnalyses();
          return;
        }
      }

      const category = event.target.closest(".category[data-category]");
      if (category) {
        const value = category.dataset.category;
        if (value === "Resources") {
          location.hash = "library";
          return;
        }
        const matching = state.courses.filter((course) =>
          String(course.category || "").toLowerCase().includes(value.toLowerCase()),
        );
        renderCourses(matching);
        location.hash = "courses";
        return;
      }

      const courseCard = event.target.closest(".course-card[data-course-id]");
      if (courseCard) {
        const course = state.courses.find(
          (item) => String(item.id) === courseCard.dataset.courseId,
        );
        if (course && !canAccess(course)) {
          event.preventDefault();
          if (!state.user) {
            setAuthMode("login");
            openModal("auth-modal");
          } else {
            openModal("subscription-modal");
          }
          return;
        }
      }

      if (event.target.classList.contains("modal-backdrop")) closeModals();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModals();
        $("#chat-panel")?.classList.remove("open");
      }
    });

    document.addEventListener("submit", async (event) => {
      const form = event.target.closest("form[data-form]");
      if (!form) return;
      event.preventDefault();
      const kind = form.dataset.form;
      const button = $("button[type='submit'], button:not([type])", form);
      if (button) button.disabled = true;
      setFormMessage(form, "جارٍ الإرسال…");

      try {
        if (kind === "auth") {
          const formData = new FormData(form);
          const payload = {
            email: formData.get("email"),
            password: formData.get("password"),
          };
          const endpoint = state.authMode === "login" ? "/auth/login" : "/auth/register";
          if (state.authMode === "register") payload.name = formData.get("name");
          const data = await api(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          state.user = data.user || (await api("/auth/me"));
          closeModals();
          form.reset();
          await checkUser();
          await loadCourses();
          const subscribeRequested = new URLSearchParams(location.search).get("subscribe");
          if (subscribeRequested === "1") openModal("subscription-modal");
          return;
        }
        if (kind === "subscription") {
          const formData = new FormData(form);
          formData.set("plan", "standard");
          await uploadFormFiles(form, formData);
          const data = await api("/subscriptions", { method: "POST", body: formData });
          setFormMessage(
            form,
            data.subscription?.status === "pending"
              ? "تم استلام الطلب وإحالته للمراجعة."
              : "استلم الخادم الطلب؛ راجع حالة اشتراكك لاحقاً.",
          );
          form.reset();
          await checkUser();
          return;
        }
        if (kind === "chat") {
          const body = new FormData(form).get("body");
          await api("/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          });
          form.reset();
          state.chatLoaded = false;
          await loadChat();
        }
      } catch (error) {
        setFormMessage(form, error.message);
      } finally {
        if (button) button.disabled = false;
        if ($(".form-msg", form)?.textContent === "جارٍ الإرسال…") {
          setFormMessage(form, "");
        }
      }
    });

    document.addEventListener("click", (event) => {
      const link = event.target.closest("#navlinks a");
      if (link) $("#navlinks").classList.remove("open");
    });

    (async () => {
      await checkUser();
      await Promise.all([
        loadCourses(),
        loadFiles("quizzes", "#quiz-files"),
        loadFiles("results", "#result-files"),
        loadNews(),
        loadAnalyses(),
      ]);
      if (new URLSearchParams(location.search).get("subscribe") === "1") {
        if (state.user) openModal("subscription-modal");
        else {
          setAuthMode("login");
          openModal("auth-modal");
        }
      }
    })();
  }

  function initCourse() {
    const host = $("#room");
    const courseId = new URLSearchParams(location.search).get("id");
    let detail = null;
    let activeLesson = null;

    const duration = (seconds) => {
      const value = Number(seconds) || 0;
      if (!value) return "درس";
      return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
    };

    function embeddedVideo(url, title) {
      try {
        const parsed = new URL(url);
        let embed = "";
        if (parsed.hostname.endsWith("youtu.be")) {
          const id = parsed.pathname.split("/").filter(Boolean)[0];
          if (id) embed = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
        } else if (parsed.hostname.endsWith("youtube.com")) {
          const id = parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).pop();
          if (id) embed = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
        } else if (parsed.hostname.endsWith("vimeo.com")) {
          const id = parsed.pathname.split("/").filter(Boolean).pop();
          if (/^\d+$/.test(id || "")) embed = `https://player.vimeo.com/video/${id}`;
        }
        if (!embed) return "";
        return `<iframe src="${embed}" title="${escapeHtml(title)}" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
      } catch {
        return "";
      }
    }

    function videoMarkup(lesson) {
      if (!lesson) {
        return '<div class="video-placeholder"><b>اختر درساً للبدء</b><span>COURSE MATERIAL</span></div>';
      }
      const source = lesson.videoUrl || lesson.videoPath;
      if (!source) {
        return `<div class="video-placeholder"><b>${escapeHtml(lesson.title)}</b><span>لا يوجد فيديو لهذا الدرس — راجع الوصف والمواد المرفقة.</span></div>`;
      }
      if (lesson.videoUrl) {
        const embed = embeddedVideo(lesson.videoUrl, lesson.title);
        if (embed) return embed;
      }
      if (lesson.videoPath || /^https?:\/\//i.test(source)) {
        return `<video controls playsinline preload="metadata" src="${escapeHtml(source)}">تعذر تشغيل الفيديو على هذا المتصفح.</video>`;
      }
      return '<div class="video-placeholder"><b>مصدر الفيديو غير صالح</b><span>تواصل مع إدارة الأكاديمية.</span></div>';
    }

    function render() {
      const course = detail.course;
      const lessons = detail.lessons || [];
      $("#crumb-title").textContent = course.title;
      document.title = `${course.title} — FADIL TRADING`;
      if (!detail.canAccess) {
        host.innerHTML = `<section class="locked-panel">
          <div class="eyebrow">محتوى محمي</div><h2>هذه الدورة تتطلب اشتراكاً فعالاً.</h2>
          <p>قدّم طلب اشتراك من الصفحة الرئيسية وأرفق إثبات الدفع. سيُفتح المحتوى بعد موافقة الإدارة.</p>
          <a href="/home.html?subscribe=1" class="btn primary">طلب الاشتراك</a>
        </section>`;
        return;
      }
      if (!activeLesson || !lessons.some((lesson) => String(lesson.id) === String(activeLesson.id))) {
        activeLesson = lessons[0] || null;
      }
      const completedCount = lessons.filter((lesson) => lesson.completed).length;
      const percentage = lessons.length ? Math.round((completedCount / lessons.length) * 100) : 0;
      const resources = detail.resources || [];
      host.innerHTML = `<div class="course-layout">
        <section class="maincol">
          <div class="video">${videoMarkup(activeLesson)}</div>
          ${activeLesson ? `<div class="lesson-top">
            <div class="eyebrow">${escapeHtml(activeLesson.category || course.category || "درس")}</div>
            <h1>${escapeHtml(activeLesson.title)}</h1>
            <p>${escapeHtml(activeLesson.description || "تابع الدرس ثم سجّل إكماله عند الانتهاء.")}</p>
            <div class="lesson-actions"><span class="status">${activeLesson.completed ? "تم إكمال هذا الدرس" : `مدة الدرس: ${duration(activeLesson.durationSeconds)}`}</span>
              <button class="btn primary" data-action="complete-lesson" data-lesson-id="${Number(activeLesson.id)}" ${activeLesson.completed ? "disabled" : ""}>${activeLesson.completed ? "تم الإكمال" : "إكمال الدرس"}</button>
            </div>
          </div>
          ${activeLesson.attachmentPath ? `<div class="resource"><span><b>مادة مرفقة للدرس</b><small>ملف إضافي لهذا الدرس</small></span><a href="${escapeHtml(activeLesson.attachmentPath)}">فتح / تنزيل ←</a></div>` : ""}
          ` : '<div class="empty-state">لا توجد دروس منشورة في هذه الدورة حالياً.</div>'}
          ${course.attachmentPath ? `<div class="resource"><span><b>مرفق الدورة</b><small>ملف تعليمي إضافي</small></span><a href="${escapeHtml(course.attachmentPath)}">فتح / تنزيل ←</a></div>` : ""}
          ${resources.length ? `<div class="resource-list"><h3>موارد الدورة</h3><div class="file-list">${resources.map((resource) => `<div class="file-row"><span>${escapeHtml(resource.title)}<small>${resource.lessonId ? "مرفق بدرس" : "مورد عام للدورة"}</small></span><a href="${escapeHtml(resource.downloadUrl)}">تنزيل ←</a></div>`).join("")}</div></div>` : ""}
        </section>
        <aside class="course-side">
          <div class="course-head"><small>COURSE ROOM / ${Number(course.id)}</small><h2>${escapeHtml(course.title)}</h2><p>${escapeHtml(course.description || "")}</p>
            <div class="progress-label"><span>تقدّمك</span><span>${completedCount} / ${lessons.length} · ${percentage}%</span></div>
            <div class="progress-track"><i style="width:${percentage}%"></i></div>
          </div>
          <div class="lesson-list">${lessons.length
            ? lessons.map((lesson, index) => `<button class="lesson-item ${activeLesson && String(activeLesson.id) === String(lesson.id) ? "active" : ""}" data-action="select-lesson" data-lesson-id="${Number(lesson.id)}">
                <span class="lesson-no">${String(index + 1).padStart(2, "0")}</span>
                <span><strong>${escapeHtml(lesson.title)}</strong><small>${duration(lesson.durationSeconds)}${lesson.category ? ` · ${escapeHtml(lesson.category)}` : ""}</small></span>
                ${lesson.completed ? '<span class="done">✓</span>' : ""}
              </button>`).join("")
            : '<div class="empty-state">لا توجد دروس منشورة.</div>'}
          </div>
        </aside>
      </div><div class="bottom-note">المحتوى تعليمي فقط ولا يشكّل توصية مالية أو دعوة لاتخاذ قرار استثماري.</div>`;
    }

    async function load() {
      if (!courseId) {
        showState(host, "لم يتم تحديد رقم الدورة في الرابط.", true);
        return;
      }
      host.innerHTML = '<div class="loading-line"></div>';
      try {
        detail = await api(`/courses/${encodeURIComponent(courseId)}`);
        render();
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      if (button.dataset.action === "retry") {
        load();
        return;
      }
      if (button.dataset.action === "select-lesson" && detail) {
        activeLesson = detail.lessons.find(
          (lesson) => String(lesson.id) === button.dataset.lessonId,
        );
        render();
        return;
      }
      if (button.dataset.action === "complete-lesson") {
        button.disabled = true;
        button.textContent = "جارٍ الحفظ…";
        try {
          await api(`/lessons/${encodeURIComponent(button.dataset.lessonId)}/complete`, {
            method: "POST",
          });
          const lesson = detail.lessons.find(
            (item) => String(item.id) === button.dataset.lessonId,
          );
          if (lesson) lesson.completed = true;
          render();
        } catch (error) {
          button.disabled = false;
          button.textContent = "إعادة المحاولة";
          const status = $(".status");
          if (status) status.textContent = error.message;
        }
      }
    });

    load();
  }

  function initAdmin() {
    const state = { courses: [], me: null };

    function setLoginError(message) {
      const form = $('[data-form="login"]');
      setFormMessage(form, message);
    }

    function showDashboard() {
      $("#login-screen").classList.add("hidden");
      $("#admin-app").classList.remove("hidden");
      $("#logout").classList.remove("hidden");
      $("#admin-welcome").textContent = `مرحباً ${state.me?.name || "بك"} — حالة البيانات مباشرة من الخادم.`;
      refreshAll();
    }

    function badge(status) {
      const classes = status === "pending" ? "pending" : status === "rejected" ? "rejected" : "";
      const labels = { pending: "قيد المراجعة", approved: "مقبول", rejected: "مرفوض" };
      return `<span class="badge ${classes}">${escapeHtml(labels[status] || status || "—")}</span>`;
    }

    async function loadOverview() {
      const host = $("#overview-stats");
      try {
        const data = await api("/admin/overview");
        const values = [
          ["الطلاب", data.students],
          ["اشتراكات فعالة", data.activeSubscriptions],
          ["بانتظار المراجعة", data.pendingSubscriptions],
          ["رسائل غير مقروءة", data.unreadMessages],
        ];
        host.innerHTML = values.map(([label, value]) => `<div class="stat"><small>${label}</small><b>${Number(value) || 0}</b></div>`).join("");
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function loadSubscriptions() {
      const host = $("#subscription-table");
      host.innerHTML = '<div class="loading-line"></div>';
      try {
        const data = await api("/admin/subscriptions");
        const subscriptions = data.subscriptions || [];
        if (!subscriptions.length) {
          showState(host, "لا توجد طلبات اشتراك حالياً.");
          return;
        }
        host.innerHTML = `<table><thead><tr><th>الطالب</th><th>الخطة</th><th>الحالة</th><th>تاريخ الطلب</th><th>الإثبات</th><th>قرار المراجعة</th></tr></thead><tbody>
          ${subscriptions.map((subscription) => `<tr>
            <td>${escapeHtml(subscription.userName || `طالب #${subscription.userId}`)}</td>
            <td>${escapeHtml(subscription.plan)}</td><td>${badge(subscription.status)}</td>
            <td>${formatDate(subscription.createdAt)}</td>
            <td>${subscription.proofUrl ? `<a class="proof-link" href="${escapeHtml(subscription.proofUrl)}" target="_blank" rel="noopener">فتح الإثبات</a>` : "غير متاح"}</td>
            <td>${subscription.status === "pending" ? `<div class="row-actions">
              <button class="btn tiny primary" data-action="review" data-status="approved" data-id="${Number(subscription.id)}">اعتماد</button>
              <button class="btn tiny danger" data-action="review" data-status="rejected" data-id="${Number(subscription.id)}">رفض</button>
            </div>` : "—"}</td>
          </tr>`).join("")}
        </tbody></table>`;
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function loadCourses() {
      try {
        const data = await api("/admin/courses");
        state.courses = data.courses || [];
        const options = '<option value="">اختر دورة</option>' +
          state.courses.map((course) => `<option value="${Number(course.id)}">${escapeHtml(course.title)}</option>`).join("");
        $$("[data-course-select]").forEach((select) => {
          const previous = select.value;
          select.innerHTML = options;
          if (state.courses.some((course) => String(course.id) === previous)) {
            select.value = previous;
          }
        });
        const host = $("#course-list");
        host.innerHTML = state.courses.length
          ? state.courses.map((course) => `<div class="conversation">
              <div class="conversation-head"><b>${escapeHtml(course.title)}</b><small>${escapeHtml(course.category)} · ${course.isPublished ? "منشورة" : "مسودة"} · ${course.isFree ? "مجانية" : "مدفوعة"}</small></div>
              <p>${escapeHtml(course.description || "")} · ${Number(course.lessonCount) || 0} درس</p>
              ${course.lessons?.length ? `<p>${course.lessons.map((lesson) => escapeHtml(lesson.title)).join(" · ")}</p>` : ""}
            </div>`).join("")
          : '<div class="list-state">لا توجد دورات بعد. أنشئ دورة من النموذج المجاور.</div>';
      } catch (error) {
        showState($("#course-list"), error.message, true);
      }
    }

    async function loadMessages() {
      const host = $("#message-inbox");
      host.innerHTML = '<div class="loading-line"></div>';
      try {
        const data = await api("/admin/messages");
        const messages = data.messages || [];
        if (!messages.length) {
          showState(host, "لا توجد رسائل دعم حالياً.");
          return;
        }
        const grouped = new Map();
        messages.forEach((message) => {
          if (!grouped.has(message.userId)) grouped.set(message.userId, []);
          grouped.get(message.userId).push(message);
        });
        host.innerHTML = [...grouped.entries()].map(([userId, items]) => `<div class="conversation">
          <div class="conversation-head"><b>${escapeHtml(items[0]?.userName || `طالب #${userId}`)}</b><small>${items.length} رسالة</small></div>
          ${items.map((message) => `<p><b>${message.senderRole === "admin" ? "الإدارة" : "الطالب"}:</b> ${escapeHtml(message.body)} <small> · ${formatDate(message.createdAt)}</small></p>`).join("")}
          <form class="reply-form" data-form="reply" data-user="${Number(userId)}"><input name="body" maxlength="4000" placeholder="اكتب رداً للطالب…" required><button class="btn tiny primary">إرسال الرد</button></form><div class="form-msg"></div>
        </div>`).join("");
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function loadStudents() {
      const host = $("#students-table");
      host.innerHTML = '<div class="loading-line"></div>';
      try {
        const data = await api("/admin/students");
        const students = data.students || [];
        if (!students.length) {
          showState(host, "لا توجد سجلات طلاب.");
          return;
        }
        host.innerHTML = `<table class="student-progress"><thead><tr><th>الطالب</th><th>البريد</th><th>الاشتراك</th><th>الدروس المكتملة</th><th>التسجيل</th></tr></thead><tbody>
          ${students.map((student) => `<tr>
            <td>${escapeHtml(student.name)}</td><td dir="ltr">${escapeHtml(student.email)}</td>
            <td>${student.isSubscribed ? '<span class="badge">فعال</span>' : '<span class="badge pending">غير مشترك</span>'}</td>
            <td>${Number(student.completedLessons) || 0} / ${Number(student.totalLessons) || 0}</td>
            <td>${formatDate(student.joinedAt)}</td>
          </tr>`).join("")}
        </tbody></table>`;
      } catch (error) {
        showState(host, error.message, true);
      }
    }

    async function refreshAll() {
      await Promise.all([
        loadOverview(),
        loadSubscriptions(),
        loadCourses(),
        loadMessages(),
        loadStudents(),
      ]);
    }

    async function checkSession() {
      try {
        state.me = await api("/auth/me");
        if (state.me.role === "admin") showDashboard();
        else {
          $("#login-screen").classList.remove("hidden");
          setLoginError("هذا الحساب لا يملك صلاحية الإدارة.");
        }
      } catch {
        $("#login-screen").classList.remove("hidden");
      }
    }

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      if (button.dataset.action === "retry") {
        await refreshAll();
        return;
      }
      if (button.dataset.action === "refresh") {
        await refreshAll();
        return;
      }
      if (button.dataset.action === "logout") {
        button.disabled = true;
        try {
          await api("/auth/logout", { method: "POST" });
          location.reload();
        } catch (error) {
          button.disabled = false;
          $("#global-msg").textContent = error.message;
        }
        return;
      }
      if (button.dataset.action === "review") {
        const approve = button.dataset.status === "approved";
        if (!window.confirm(approve ? "تأكيد اعتماد الاشتراك؟" : "تأكيد رفض الاشتراك؟")) return;
        button.disabled = true;
        try {
          await api(`/admin/subscriptions/${encodeURIComponent(button.dataset.id)}/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: button.dataset.status }),
          });
          await Promise.all([loadSubscriptions(), loadOverview()]);
        } catch (error) {
          button.disabled = false;
          $("#global-msg").textContent = error.message;
        }
      }
    });

    document.addEventListener("change", (event) => {
      const select = event.target.closest("[data-course-select]");
      if (!select) return;
      const form = select.closest('[data-form="resource"]');
      const lessonSelect = form?.querySelector("[data-lesson-select]");
      if (!lessonSelect) return;
      const course = state.courses.find((item) => String(item.id) === select.value);
      lessonSelect.innerHTML = '<option value="">مورد عام للدورة</option>' +
        (course?.lessons || []).map((lesson) => `<option value="${Number(lesson.id)}">${escapeHtml(lesson.title)}</option>`).join("");
    });

    document.addEventListener("click", (event) => {
      const link = event.target.closest(".side-nav a");
      if (link) {
        $$(".side-nav a").forEach((item) => item.classList.toggle("active", item === link));
      }
    });

    document.addEventListener("submit", async (event) => {
      const form = event.target.closest("form[data-form]");
      if (!form) return;
      event.preventDefault();
      const kind = form.dataset.form;
      const button = $("button[type='submit'], button:not([type])", form);
      if (button) button.disabled = true;
      setFormMessage(form, "جارٍ الإرسال إلى الخادم…");

      try {
        if (kind === "login") {
          const formData = new FormData(form);
          await api("/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: formData.get("email"),
              password: formData.get("password"),
            }),
          });
          state.me = await api("/auth/me");
          if (state.me.role !== "admin") {
            await api("/auth/logout", { method: "POST" });
            throw new Error("هذا الحساب لا يملك صلاحية الإدارة.");
          }
          form.reset();
          showDashboard();
          return;
        }

        if (kind === "reply") {
          const body = new FormData(form).get("body");
          await api(`/admin/messages/${encodeURIComponent(form.dataset.user)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          });
          form.reset();
          await loadMessages();
          return;
        }

        const formData = new FormData(form);
        await uploadFormFiles(form, formData);
        let endpoint = "";
        const options = { method: "POST" };

        if (kind === "course") {
          endpoint = "/admin/courses";
          formData.set("isPublished", form.elements.isPublished.checked ? "true" : "false");
          formData.set("isFree", form.elements.isFree.checked ? "true" : "false");
          options.body = formData;
        } else if (kind === "lesson") {
          endpoint = "/admin/lessons";
          formData.set("courseId", String(Number(formData.get("courseId"))));
          formData.set("durationSeconds", String(Number(formData.get("durationSeconds")) || 0));
          formData.set("isPublished", form.elements.isPublished.checked ? "true" : "false");
          options.body = formData;
        } else if (kind === "resource") {
          endpoint = "/admin/resources";
          formData.set("courseId", String(Number(formData.get("courseId"))));
          if (!formData.get("lessonId")) formData.delete("lessonId");
          else formData.set("lessonId", String(Number(formData.get("lessonId"))));
          options.body = formData;
        } else if (kind === "news") {
          endpoint = "/admin/news";
          options.headers = { "Content-Type": "application/json" };
          options.body = JSON.stringify({
            title: formData.get("title"),
            summary: formData.get("summary"),
            category: formData.get("category"),
            sourceUrl: formData.get("sourceUrl") || "",
            isPublished: form.elements.isPublished.checked,
          });
        } else if (kind === "analysis") {
          endpoint = "/admin/analyses";
          formData.set("isPublished", form.elements.isPublished.checked ? "true" : "false");
          options.body = formData;
        } else if (kind === "quizzes" || kind === "results") {
          endpoint = `/admin/files/${kind}`;
          options.body = formData;
        } else {
          throw new Error("نوع النموذج غير معروف.");
        }

        await api(endpoint, options);
        setFormMessage(form, "تم الحفظ بنجاح.");
        form.reset();
        if (kind === "course" || kind === "lesson" || kind === "resource") {
          await loadCourses();
        }
      } catch (error) {
        setFormMessage(form, error.message);
      } finally {
        if (button) button.disabled = false;
        if ($(".form-msg", form)?.textContent === "جارٍ الإرسال إلى الخادم…") {
          setFormMessage(form, "");
        }
      }
    });

    checkSession();
  }
})();
