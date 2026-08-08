/* ============================================================
   MEELAD FEST — app.js
   Plain JavaScript, no build step. Data lives in memory (seeded
   from the JSON embedded in index.html / data.json).

   TO CONNECT FIREBASE LATER: see FIREBASE-SETUP.md. The only
   places you need to touch are marked with "FIREBASE HOOK" below —
   swap the in-memory read/write for firebase.database() calls.
   ============================================================ */
(function () {
  "use strict";

  // ============================================================
  // IMGBB CONFIG — paste your own free API key below.
  // 1. Go to https://api.imgbb.com/  →  "Get API Key" (free, no card, instant)
  // 2. Copy the key and paste it between the quotes here
  // Until a real key is pasted, event photos are stored directly in
  // Firebase (works fine, just uses a bit more Firebase bandwidth/sync size
  // as the gallery grows) — nothing breaks either way.
  const IMGBB_API_KEY = "7d292508d92db8758504f55f792ad53f";
  // ============================================================
  function uploadToImgBB(dataUrl) {
    if (!IMGBB_API_KEY || IMGBB_API_KEY.indexOf("PASTE_") === 0) return Promise.resolve(dataUrl);
    const base64 = dataUrl.split(",")[1];
    const body = new FormData();
    body.append("image", base64);
    return fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: "POST", body })
      .then((res) => res.json())
      .then((json) => {
        if (json && json.success && json.data && json.data.url) return json.data.url;
        throw new Error("ImgBB upload failed");
      })
      .catch(() => dataUrl); // if ImgBB is unreachable, fall back to storing the image directly rather than losing the upload
  }

  /* ---------------- data layer ---------------- */
  const seed = JSON.parse(document.getElementById("seed-data").textContent);
  let state = {
    hero: seed.hero,
    categories: seed.categories,
    categoryStartNumbers: seed.categoryStartNumbers || {},
    limits: seed.limits,
    teams: seed.teams,
    events: seed.events,
    students: seed.students,
    results: seed.results,
    gallery: seed.gallery,
    marks: seed.marks || {},
    judges: seed.judges || ["Judge 1"],
    customTemplates: seed.customTemplates || [],
    cardTemplates: seed.cardTemplates || [],
    masterCardTemplate: seed.masterCardTemplate || { imageUrl: null, placements: [] },
    resultTemplates: seed.resultTemplates || [],
    printHistory: seed.printHistory || [],
  };

  function ensureStateDefaults() {
    state.hero = state.hero || seed.hero;
    if (state.hero.statsBoxPhotoUrl) delete state.hero.statsBoxPhotoUrl; // feature removed
    state.categories = state.categories || seed.categories;
    state.limits = state.limits || seed.limits;
    if (state.limits.maxStage == null) state.limits.maxStage = 5;
    if (state.limits.maxOffStage == null) state.limits.maxOffStage = 5;
    state.teams = state.teams || [];
    state.events = state.events || [];
    state.students = state.students || [];
    state.results = state.results || {};
    state.gallery = state.gallery || [];
    state.marks = state.marks || {};
    state.codes = state.codes || {};
    state.judges = state.judges || ["Judge 1"];
    state.customTemplates = state.customTemplates || [];
    state.cardTemplates = state.cardTemplates || [];
    state.masterCardTemplate = state.masterCardTemplate || { imageUrl: null, placements: [] };
    if (!state.masterCardTemplate.placements) state.masterCardTemplate.placements = [];
    state.resultTemplates = state.resultTemplates || [];
    state.categoryStartNumbers = state.categoryStartNumbers || {};
    state.printHistory = state.printHistory || [];
    state.schedule = state.schedule || [];
    state.printHeaderName = state.printHeaderName || "";
    state.events.forEach((e) => {
      if (!e.resultStatus) e.resultStatus = state.results[e.id] ? "Published" : "Pending";
      if (!e.assignedJudges) e.assignedJudges = [...state.judges];
      if (!e.stageType) e.stageType = "Stage";
      e.status = e.status || "pending";
    });
    state.students.forEach((s) => { s.events = s.events || []; });
    // Every category needs a start number; new categories default to 1.
    state.categories.forEach((c) => {
      if (state.categoryStartNumbers[c] == null) state.categoryStartNumbers[c] = 1;
    });
  }
  ensureStateDefaults();

  /* ---------------- Firebase (Realtime Database) ----------------
     Each madrasa gets its OWN Firebase project (separate account, separate
     link) — swap the config block below when setting up a new madrasa's
     copy of this site. Because every madrasa has a fully separate Firebase
     database, there is no shared storage quota and no possibility of one
     madrasa's photos/text ever appearing on another madrasa's site. */
  const firebaseConfig = {
    apiKey: "AIzaSyDd-VQ5hJnbf3j3PhouJx8x2vDnmXXM3fE",
    authDomain: "meelad-tvna.firebaseapp.com",
    databaseURL: "https://meelad-tvna-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "meelad-tvna",
    storageBucket: "meelad-tvna.firebasestorage.app",
    messagingSenderId: "491626187701",
    appId: "1:491626187701:web:b2e246dd45dac7ca9667fc",
  };
  let dataRef = null;
  let firebaseReady = false;
  let suppressNextPersist = false;
  try {
    firebase.initializeApp(firebaseConfig);
    dataRef = firebase.database().ref("festData");
  } catch (err) {
    console.error("Firebase init failed, running on local data only:", err);
    document.addEventListener("DOMContentLoaded", () => {
      const banner = document.getElementById("saveFailBanner");
      if (banner) { banner.textContent = "\u26A0 Could not connect to the server \u2014 changes will not be saved."; banner.classList.remove("hidden"); }
    });
  }

  const uid = () => Math.random().toString(36).slice(2, 9);

  // Resizes + re-compresses an uploaded image file so it stays small in Firebase
  // (which is not meant for big binary blobs) while staying visually sharp.
  // Photos are resized then re-encoded as WebP (roughly 70% smaller than an
  // equivalent-quality JPEG at the same dimensions). Browsers that can't encode
  // WebP (older Safari) fall back to PNG automatically per the canvas spec —
  // bigger file, but nothing breaks.
  function compressImageFile(file, maxDim = 1000, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Could not load image"));
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/webp", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function compressImagePngFile(file, maxDim = 1200) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Could not load image"));
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/png")); // PNG keeps transparency, unlike the JPEG compressor above
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  const RANK_POINTS = { first: 5, second: 3, third: 1 };
  const RANK_LABEL = { first: "1st Place", second: "2nd Place", third: "3rd Place" };
  const RANK_ORDINAL = { first: "1st", second: "2nd", third: "3rd" };
  const RANK_ICON = { first: "\u{1F947}", second: "\u{1F948}", third: "\u{1F949}" };
  const RANK_NUMBER = { first: 1, second: 2, third: 3 };
  const ORDINAL = (n) => n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
  // Bug fix: deleting a student/event/team used to leave that student's mark
  // entries behind in state.marks, so counts like "Marks Entered" on the
  // Dashboard kept counting data that had supposedly been deleted. These
  // helpers scrub every trace of the deleted record before persist().
  function removeStudentEverywhere(studentId) {
    Object.keys(state.marks).forEach((eventId) => { delete state.marks[eventId][studentId]; });
  }
  function removeEventEverywhere(eventId) {
    delete state.marks[eventId];
    delete state.results[eventId];
    state.students.forEach((s) => { s.events = (s.events || []).filter((id) => id !== eventId); });
  }
  function removeTeamEverywhere(teamId) {
    const teamStudentIds = state.students.filter((s) => s.team === teamId).map((s) => s.id);
    teamStudentIds.forEach(removeStudentEverywhere);
    state.students = state.students.filter((s) => s.team !== teamId);
  }
  // One-time sweep for marks/results left behind by deletes made *before*
  // the cascade cleanup above existed (e.g. old Test Data deletes). Returns
  // how many stray entries it removed, so the Dashboard button can report it.
  function cleanOrphanedData() {
    const validEventIds = new Set(state.events.map((e) => e.id));
    const validStudentIds = new Set(state.students.map((s) => s.id));
    let removed = 0;
    Object.keys(state.marks).forEach((eventId) => {
      if (!validEventIds.has(eventId)) { removed += Object.keys(state.marks[eventId]).length; delete state.marks[eventId]; return; }
      Object.keys(state.marks[eventId]).forEach((studentId) => {
        if (!validStudentIds.has(studentId)) { delete state.marks[eventId][studentId]; removed++; }
      });
    });
    Object.keys(state.results).forEach((eventId) => { if (!validEventIds.has(eventId)) delete state.results[eventId]; });
    return removed;
  }

  // Chest numbers fill the lowest available slot in a category, starting from
  // that category's Start Number. Deleting a student frees their number — the
  // very next student added gets that same number back (numbers are reused,
  // never skipped or permanently retired). Always 3-digit zero-padded (e.g. 005).
  function nextChestNo(category) {
    const start = state.categoryStartNumbers[category] || 1;
    const used = new Set(
      state.students.filter((s) => s.category === category).map((s) => parseInt(s.chestNo, 10))
    );
    let n = start;
    while (used.has(n)) n++;
    return String(n).padStart(3, "0");
  }

  // Group-programme leader: the first student of a team registered for a given
  // Group event is that team's "leader" for it — results only ever show the leader.
  function isGroupLeader(eventId, studentId) {
    const student = state.students.find((s) => s.id === studentId);
    if (!student) return false;
    const event = state.events.find((e) => e.id === eventId);
    if (!event || event.type !== "Group") return true;
    const teammates = state.students.filter((s) => s.team === student.team && s.events.includes(eventId));
    return teammates.length ? teammates[0].id === studentId : false;
  }
  // Participant list for scoring/results purposes: for Group events this collapses
  // every team down to just its leader, so each team is judged/ranked once.
  function groupAwareParticipants(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    const all = state.students.filter((s) => s.events.includes(eventId));
    if (!event || event.type !== "Group") return all;
    return all.filter((s) => isGroupLeader(eventId, s.id));
  }
  // True once a team already has as many members in this Group event as its configured limit.
  function groupTeamFull(eventId, teamId, excludeStudentId) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event || event.type !== "Group" || !teamId) return false;
    const limit = event.groupLimit || 4;
    const count = state.students.filter((s) => s.team === teamId && s.events.includes(eventId) && s.id !== excludeStudentId).length;
    return count >= limit;
  }

  // Writes the whole app state to Firebase so every device/browser sees the same live data.
  // ensureStateDefaults() runs first every time so any record created anywhere in the
  // app (test data, quick-add flows, etc.) always has every field it needs (assignedJudges,
  // resultStatus, status...) before it's saved \u2014 this is what was causing Green Room /
  // Mark Entry to crash on events that were missing assignedJudges.
  function persist() {
    ensureStateDefaults();
    if (!dataRef) {
      const banner = document.getElementById("saveFailBanner");
      if (banner) { banner.textContent = "\u26A0 Not connected to the server \u2014 changes will not be saved."; banner.classList.remove("hidden"); }
      return;
    }
    suppressNextPersist = true;
    // Firebase Realtime Database rejects any write containing an `undefined`
    // value anywhere in the object (e.g. state.hero.posterTemplate before a
    // template is picked) \u2014 the whole save silently fails with "set failed:
    // value argument contains undefined in property '...'". Round-tripping
    // through JSON strips every undefined (turning it into null / omitting
    // it) so this can never block a save again, no matter which field it is.
    const cleanState = JSON.parse(JSON.stringify(state));
    dataRef.set(cleanState).then(() => {
      const banner = document.getElementById("saveFailBanner");
      if (banner) banner.classList.add("hidden");
    }).catch((err) => {
      console.error("Firebase write failed:", err);
      showToast("Could not save to Firebase \u2014 check your connection");
      // A toast alone fades in ~3s and is easy to miss if you're not looking
      // right then. This banner stays up until a save actually succeeds \u2014
      // the most common real-world cause is Firebase Realtime Database
      // "test mode" rules expiring (they auto-deny all writes after 30 days),
      // which otherwise fails completely silently: uploads to ImgBB still
      // succeed, the UI still looks fine, but nothing ever reaches the
      // server, so a refresh reverts everything. Check Firebase Console ->
      // Realtime Database -> Rules if this banner keeps appearing.
      const banner = document.getElementById("saveFailBanner");
      if (banner) banner.classList.remove("hidden");
    });
  }

  /* ---------------- mark-entry helpers ---------------- */
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function codeLetterFor(eventId, studentId) {
    const override = state.codes[eventId] && state.codes[eventId][studentId];
    if (override) return override;
    const participants = state.students.filter((s) => s.events.includes(eventId));
    const idx = participants.findIndex((s) => s.id === studentId);
    return idx >= 0 ? LETTERS[idx % LETTERS.length] : "-";
  }
  // For Group programmes only the leader's name is stored against the result,
  // so this appends "(and Team)" wherever that name is shown in results, to
  // make clear it's a team entry and not a solo individual placement.
  function resultDisplayName(eventOrId, name) {
    const event = typeof eventOrId === "string" ? state.events.find((e) => e.id === eventOrId) : eventOrId;
    return event && event.type === "Group" ? `${name} and Team` : name;
  }
  function finalMarkFor(eventId, studentId) {
    const judgeMarks = (state.marks[eventId] || {})[studentId] || {};
    const vals = Object.values(judgeMarks).filter((v) => v !== "" && v != null && !isNaN(v)).map(Number);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  }
  function rankedParticipants(eventId) {
    const participants = groupAwareParticipants(eventId);
    return participants
      .map((s) => ({ student: s, mark: finalMarkFor(eventId, s.id) }))
      .sort((a, b) => (b.mark ?? -Infinity) - (a.mark ?? -Infinity));
  }

  // Total points a student has accumulated across every programme they're registered
  // in (optionally filtered to just "Stage" or "Off-stage" programmes). For Group
  // programmes only the team leader is marked, so every teammate shares that same
  // result \u2014 the whole team performed together.
  //
  // Uses the same 1st/2nd/3rd placement points (RANK_POINTS) as the team
  // leaderboard \u2014 a student only scores here if they've been placed 1st, 2nd
  // or 3rd in a published result for that programme. No grade system involved.
  function computeStudentTotalMarks(studentId, stageTypeFilter) {
    const student = state.students.find((s) => s.id === studentId);
    if (!student) return 0;
    let total = 0;
    (student.events || []).forEach((eventId) => {
      const event = state.events.find((e) => e.id === eventId);
      if (!event) return;
      if (event.type === "Group") return; // Group programme points count toward the team only, not individual Top Score
      if (stageTypeFilter && (event.stageType || "Stage") !== stageTypeFilter) return;
      const result = state.results[eventId];
      if (!result) return;
      ["first", "second", "third"].forEach((rank) => {
        const entry = result[rank];
        if (!entry) return;
        const ids = entry.tiedIds && entry.tiedIds.length ? entry.tiedIds : [entry.studentId];
        if (ids.includes(studentId)) total += RANK_POINTS[rank];
      });
    });
    return total;
  }

  // Full Top Score leaderboard: every student's total marks, plus their
  // Stage-only and Off-stage-only totals (used to crown Vocal/Pen of the Fest).
  function computeTopScoreLeaderboard() {
    return state.students
      .map((s) => ({
        student: s,
        total: computeStudentTotalMarks(s.id),
        stageTotal: computeStudentTotalMarks(s.id, "Stage"),
        offStageTotal: computeStudentTotalMarks(s.id, "Off-stage"),
      }))
      .sort((a, b) => b.total - a.total);
  }

  // Expands a published result into individual {rank, student, team} rows \u2014
  // if a placement was tied, every tied student gets their own row at that
  // same rank (instead of only the first-recorded student showing up).
  // Shared table format for showing a single programme's result to guests \u2014
  // used by both the search-icon result block and the results feed's expanded
  // card, so a "result" always looks the same no matter how you got to it.
  function renderResultTable(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event) return "";
    const ranked = rankedParticipants(eventId).filter((r) => r.mark != null);
    if (!ranked.length) return `<div class="empty-note">No marks recorded for this programme yet.</div>`;
    return `
      <div style="overflow-x:auto">
      <table class="result-detail-table"><thead><tr>
        <th>No</th><th>Chest No</th><th>Name</th><th>Code Letter</th><th>Team</th><th>Mark</th><th>Points</th>
      </tr></thead><tbody>
        ${ranked.map((r, i) => {
          const team = state.teams.find((t) => t.id === r.student.team);
          const rankKey = i === 0 ? "first" : i === 1 ? "second" : i === 2 ? "third" : null;
          return `<tr>
            <td>${i + 1}</td>
            <td>${r.student.chestNo}</td>
            <td>${escapeHtml(resultDisplayName(event, r.student.name))}</td>
            <td>${codeLetterFor(eventId, r.student.id)}</td>
            <td>${team ? escapeHtml(team.name) : ""}</td>
            <td>${r.mark}</td>
            <td>${rankKey ? RANK_POINTS[rankKey] : 0}</td>
          </tr>`;
        }).join("")}
      </tbody></table>
      </div>`;
  }

  // Guest-facing (home page) winners summary: rank, name, chest no, team
  // ONLY. Team Points / Mark are internal scoring details and
  // are shown to admins only (Admin -> Result -> View), never on the public
  // home page feed or the search-icon result block.
  function renderPublicWinnersTable(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    const winners = getWinnersForEvent(eventId);
    if (!winners.length) return `<div class="empty-note">No winners recorded for this programme yet.</div>`;
    return `
      <div class="rf-winners-simple">
        ${winners.map((w) => {
          const team = state.teams.find((t) => t.id === w.student.team);
          return `<div class="result-row">
            <span class="win-rank">${RANK_ICON[w.rank]} ${RANK_ORDINAL[w.rank]}</span>
            <span class="result-name">${escapeHtml(resultDisplayName(event, w.student.name))}</span>
            <span class="result-meta">${w.student.chestNo}${team ? " \u00b7 " + escapeHtml(team.name) : ""}</span>
          </div>`;
        }).join("")}
      </div>`;
  }

  function getWinnersForEvent(eventId) {
    const result = state.results[eventId];
    if (!result) return [];
    const winners = [];
    ["first", "second", "third"].forEach((rank) => {
      const entry = result[rank];
      if (!entry) return;
      const ids = entry.tiedIds && entry.tiedIds.length ? entry.tiedIds : [entry.studentId];
      ids.forEach((studentId) => {
        const student = state.students.find((s) => s.id === studentId);
        if (!student) return;
        const team = state.teams.find((t) => t.id === student.team);
        winners.push({ rank, student, team });
      });
    });
    return winners;
  }

  function publishEventResult(eventId) {
    const ranked = rankedParticipants(eventId).filter((r) => r.mark != null);
    if (!ranked.length) return false; // nothing marked yet \u2014 don't publish an empty/invisible result

    // Group into placement tiers by mark, so equal marks share the same
    // placement (e.g. two students both scoring highest both become "first",
    // and whoever's next becomes "second" \u2014 not "third").
    const tiers = [];
    ranked.forEach((r) => {
      const tier = tiers[tiers.length - 1];
      if (tier && tier.mark === r.mark) tier.students.push(r.student);
      else tiers.push({ mark: r.mark, students: [r.student] });
    });

    const result = { first: null, second: null, third: null };
    ["first", "second", "third"].forEach((rank, i) => {
      const tier = tiers[i];
      if (tier) result[rank] = { studentId: tier.students[0].id, tiedIds: tier.students.map((s) => s.id) };
    });
    state.results[eventId] = result;
    const ev = state.events.find((e) => e.id === eventId);
    ev.resultStatus = "Published";
    persist();
    return true;
  }
  function unpublishEventResult(eventId) {
    delete state.results[eventId];
    const ev = state.events.find((e) => e.id === eventId);
    ev.resultStatus = "Pending";
    persist();
  }

  // Three-state status for the admin Results section: Pending (no marks
  // entered yet), Submitted (marks saved via Mark Entry but not published),
  // Published (live on the home page).
  function getResultStatus(event) {
    if (event.resultStatus === "Published") return "Published";
    const marks = state.marks[event.id];
    if (marks && Object.keys(marks).length) return "Submitted";
    return "Pending";
  }

  /* ---------------- toast ---------------- */
  let toastTimer;
  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
  }

  // If any button click or render throws an error, this shows it as a toast
  // instead of the button silently doing nothing \u2014 so a broken action is
  // always visible (and the message can be screenshotted for debugging)
  // rather than looking like the app just ignored the tap.
  window.addEventListener("error", (e) => {
    console.error("Unexpected error:", e.error || e.message);
    showToast("Something went wrong: " + (e.message || "unknown error").slice(0, 80));
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unexpected error:", e.reason);
    showToast("Something went wrong: " + String(e.reason && e.reason.message || e.reason).slice(0, 80));
  });

  /* ---------------- back-navigation stack (for overlay screens) ----------------
     Uses real browser History entries so the device's physical/gesture back
     button (not just our on-screen button) closes the current screen instead
     of exiting the site \u2014 there's now an actual history entry for it to land
     on. popScreen() only *requests* a back-navigation (history.back()); the
     matching screen is actually closed inside the popstate handler, so every
     path (our buttons, hardware back, edge-swipe) closes exactly one screen. */
  const screenStack = [];
  let suppressNextPopstate = false;

  // Robust background-scroll lock: plain `overflow:hidden` on <body> doesn't
  // reliably stop scroll on mobile (the page behind an overlay can still be
  // dragged/rubber-banded into view). Pinning the body with position:fixed
  // at its current scroll offset actually removes it from the scrollable
  // flow, so whatever mode/screen is open is the only thing that can
  // scroll \u2014 the mode underneath stays completely put until you close back
  // down to it. Hooked into the screen stack below so every overlay (Admin,
  // Participant Dashboard, modals, print sheet) locks/unlocks consistently
  // with no per-screen wiring needed.
  let savedScrollY = 0;
  function lockBodyScroll() {
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.position = "fixed";
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.classList.add("no-scroll");
  }
  function unlockBodyScroll() {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.classList.remove("no-scroll");
    window.scrollTo(0, savedScrollY);
  }

  function pushScreen(closeFn) {
    if (screenStack.length === 0) lockBodyScroll();
    screenStack.push(closeFn);
    history.pushState({ meelaScreen: screenStack.length }, "", location.pathname + location.search);
  }
  function popScreen() {
    if (screenStack.length) history.back();
  }
  // Closes the current top screen INSTANTLY (no waiting for the async
  // history.back() round-trip) while still keeping the browser's history
  // entry consumed so hardware/gesture back stays correct afterwards. Use
  // this for any user-clicked close action (X button, outside-click,
  // Cancel, nav links) so the UI never lags.
  function closeTopScreen() {
    if (!screenStack.length) return;
    const fn = screenStack.pop();
    if (fn) fn();
    if (screenStack.length === 0) unlockBodyScroll();
    suppressNextPopstate = true;
    history.back();
  }
  // Replaces the current top screen with a new one in a single step (e.g.
  // Sidebar -> Login, Login -> Admin Panel). Uses history.replaceState
  // instead of back()+pushState, which was the source of the guest-mode /
  // login navigation bugs: an async history.back() immediately followed by
  // a synchronous pushState() can race and leave a stale history entry
  // behind, which is exactly what made Cancel land on the wrong screen.
  function swapTopScreen(newCloseFn) {
    if (screenStack.length) {
      screenStack[screenStack.length - 1] = newCloseFn;
      history.replaceState({ meelaScreen: screenStack.length }, "", location.pathname + location.search);
    } else {
      pushScreen(newCloseFn);
    }
  }
  window.addEventListener("popstate", () => {
    if (suppressNextPopstate) { suppressNextPopstate = false; return; }
    if (screenStack.length) {
      const fn = screenStack.pop();
      if (fn) fn();
      if (screenStack.length === 0) unlockBodyScroll();
      return;
    }
    // No overlay screen was open, so this back-press happened right on the
    // home page — let it just exit normally (single press), no confirmation.
  });

  // Some mobile browsers restore the page from the back-forward cache when
  // the site is reopened after being closed, which can leave an overlay
  // screen showing instead of the home page. Force everything closed so a
  // reopen always lands on the home page.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    while (screenStack.length) {
      const fn = screenStack.pop();
      if (fn) fn();
    }
    unlockBodyScroll();
  });

  // Most modern mobile browsers already map an edge-swipe gesture to native
  // back navigation (which the popstate listener above already handles). This
  // touch fallback covers browsers/PWA contexts where that isn't wired up.
  let touchStartX = 0, touchStartY = 0;
  document.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });
  document.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (dx > 80 && Math.abs(dy) < 60 && touchStartX < 60 && screenStack.length) closeTopScreen();
  });

  /* ---------------- theme toggle (light/dark, saved per device) ---------------- */
  const themeToggleBtn = document.getElementById("themeToggleBtn");
  const adminThemeToggleBtn = document.getElementById("btnAdminTheme");
  function applyThemeIcon() {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const icon = isLight ? "\u2600\uFE0F" : "\u{1F319}";
    if (themeToggleBtn) themeToggleBtn.textContent = icon;
    if (adminThemeToggleBtn) adminThemeToggleBtn.textContent = icon;
  }
  applyThemeIcon();
  function toggleTheme() {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    if (isLight) {
      document.documentElement.removeAttribute("data-theme");
      safeStorageSet("meelad-theme", "dark");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
      safeStorageSet("meelad-theme", "light");
    }
    applyThemeIcon();
  }
  if (themeToggleBtn) themeToggleBtn.addEventListener("click", toggleTheme);
  if (adminThemeToggleBtn) adminThemeToggleBtn.addEventListener("click", toggleTheme);

  /* ---------------- sidebar ---------------- */
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  function openSidebar() { sidebar.classList.add("open"); sidebarOverlay.classList.remove("hidden"); pushScreen(closeSidebar); }
  function closeSidebar() { sidebar.classList.remove("open"); sidebarOverlay.classList.add("hidden"); }
  document.getElementById("btnMenu").addEventListener("click", openSidebar);
  document.getElementById("btnCloseSidebar").addEventListener("click", closeTopScreen);
  sidebarOverlay.addEventListener("click", closeTopScreen);
  document.querySelectorAll(".side-link[data-nav]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const id = a.getAttribute("href").slice(1);
    closeTopScreen(); // close the sidebar instantly
    const target = document.getElementById(id);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: "smooth" }), 50);
  }));
  document.getElementById("brandHome").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  // Points (#standings) and Result (#results) both stay visible on the one
  // scrollable home page now — no more show/hide toggle between them. Every
  // link to either just scrolls to it.
  document.querySelectorAll('a[href="#results"], a[href="#standings"], a.primary-button[href^="#"], a.explore-card[href^="#"], .stat-card[href^="#"]').forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const id = a.getAttribute("href").slice(1);
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: "smooth" });
  }));
  // Explore Festival sits up in the hero, far above Team Points/Live Standings.
  const exploreFestivalBtn = document.getElementById("exploreFestivalBtn");
  if (exploreFestivalBtn) exploreFestivalBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const el = document.getElementById("standings");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  });

  // Bottom nav (Home / Points / Result / Events / Schedule / Profile). Unlike
  // the small stat-card links right above Standings, this can be tapped from
  // anywhere on the page (e.g. while down at Gallery), so every item needs an
  // actual scroll straight to its exact section position.
  const bnSchedule = document.getElementById("bnSchedule");
  if (bnSchedule && document.getElementById("schedule")) bnSchedule.classList.remove("hidden"); // only show if a Schedule section actually exists
  document.querySelectorAll("#homeBottomNav .nav-item").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const which = a.dataset.bn;
    if (which === "profile") { openStudentLogin(); return; }
    const el = document.getElementById(which);
    if (el) el.scrollIntoView({ behavior: "smooth" });
    document.querySelectorAll("#homeBottomNav .nav-item").forEach((n) => n.classList.toggle("active", n === a));
  }));

  /* ---------------- live ticker ---------------- */
  function renderTicker() {
    const live = state.events.filter((e) => e.status === "ticked");
    const upNext = state.events.find((e) => e.status !== "ticked");
    const badge = document.getElementById("tickerBadge");
    const text = document.getElementById("tickerText");
    if (live.length) {
      badge.textContent = "LIVE";
      badge.classList.add("live");
      text.textContent = live.map((e) => `${e.name} \u2014 ${e.category} (${e.gender})`).join("     \u2726     ");
    } else if (upNext) {
      badge.textContent = "NEXT";
      badge.classList.remove("live");
      text.textContent = `${upNext.name} \u2014 ${upNext.category} (${upNext.gender})`;
    } else {
      badge.textContent = "DONE";
      badge.classList.remove("live");
      text.textContent = "All programmes completed \u2014 check Live Standings for final results";
    }
  }

  /* ---------------- hero ---------------- */
  function typewriterEffect(el, text, loops, onComplete) {
    loops = loops || 1;
    let loopCount = 0;
    let cancelled = false;
    if (el._twCancel) el._twCancel();
    el._twCancel = () => { cancelled = true; };

    function typeOnce(cb) {
      let i = 0;
      el.textContent = "";
      const iv = setInterval(() => {
        if (cancelled) { clearInterval(iv); return; }
        i++;
        el.textContent = text.slice(0, i);
        if (i >= text.length) { clearInterval(iv); cb(); }
      }, 220); // very slow, deliberate letter-by-letter pace
    }
    function eraseOnce(cb) {
      let i = text.length;
      const iv = setInterval(() => {
        if (cancelled) { clearInterval(iv); return; }
        i--;
        el.textContent = text.slice(0, i);
        if (i <= 0) { clearInterval(iv); cb(); }
      }, 25);
    }
    function run() {
      if (cancelled) return;
      loopCount++;
      typeOnce(() => {
        if (cancelled) return;
        if (loopCount < loops) {
          setTimeout(() => eraseOnce(run), 450);
        } else if (onComplete) {
          onComplete();
        }
      });
    }
    if (!text) { el.textContent = ""; if (onComplete) onComplete(); return; }
    run();
  }

  function renderHero() {
    document.title = state.hero.title || "Festival Admin";

    // Page Header (top bar) — independent of the poster text below
    const headerText = state.hero.headerText || state.hero.title;
    const showHeader = state.hero.showHeaderText !== false;
    document.getElementById("brandTitle").textContent = headerText;
    document.getElementById("sideBrandTitle").textContent = headerText;
    document.getElementById("brandTitle").style.display = showHeader ? "" : "none";
    document.getElementById("sideBrandTitle").style.display = showHeader ? "" : "none";

    const footerEl = document.getElementById("siteFooter");
    if (footerEl) footerEl.textContent = state.hero.title ? `${state.hero.title} \u00a9 All rights reserved` : "\u00a9 All rights reserved";

    // Homepage Poster Text (badge + heading + subtitle) — shown/hidden together
    const posterHeadingEl = document.getElementById("posterHeading");
    const heroSubEl = document.getElementById("heroSubText");
    heroSubEl.textContent = state.hero.subtitle || "";
    if (posterHeadingEl.dataset.typedText !== (state.hero.title || "")) {
      posterHeadingEl.dataset.typedText = state.hero.title || "";
      heroSubEl.classList.remove("reveal-in");
      typewriterEffect(posterHeadingEl, state.hero.title || "", 1, () => {
        heroSubEl.classList.add("reveal-in");
      });
    }
    document.getElementById("posterHeading").style.color = state.hero.textColor || "";
    document.getElementById("heroSubText").style.color = state.hero.textColor || "";

    const showPoster = state.hero.showText !== false;
    document.getElementById("heroBadge").style.display = "none";
    document.getElementById("posterHeading").style.display = showPoster ? "" : "none";
    document.getElementById("heroSubText").style.display = showPoster ? "" : "none";

    const photoLayer = document.getElementById("heroPhotoLayer");
    if (state.hero.photoUrl) {
      if (photoLayer.dataset.loadedUrl !== state.hero.photoUrl) {
        // Preload before showing it \u2014 fades in once fully loaded instead of
        // popping in abruptly (which felt jarring / slow to visitors).
        photoLayer.style.opacity = "0";
        const img = new Image();
        img.onload = () => {
          photoLayer.style.backgroundImage = `url('${state.hero.photoUrl}')`;
          photoLayer.dataset.loadedUrl = state.hero.photoUrl;
          // Force a reflow so the opacity transition actually plays.
          void photoLayer.offsetWidth;
          photoLayer.style.opacity = "1";
        };
        img.src = state.hero.photoUrl;
      }
    } else {
      photoLayer.dataset.loadedUrl = "";
      photoLayer.style.opacity = "0";
      photoLayer.style.backgroundImage = "";
    }

    // Header bar background photo (optional) — small dark overlay baked in so
    // the header text stays readable over any photo.
    const topbar = document.querySelector(".topbar");
    if (topbar) {
      if (state.hero.headerPhotoUrl) {
        topbar.style.backgroundImage = `linear-gradient(rgba(6,36,26,.6), rgba(6,36,26,.6)), url('${state.hero.headerPhotoUrl}')`;
        topbar.style.backgroundSize = "cover";
        topbar.style.backgroundPosition = "center";
      } else {
        topbar.style.backgroundImage = "";
      }
    }

  }

  /* ---------------- counters ---------------- */
  function pulseCounter(el, newVal) {
    if (el.dataset.lastVal === String(newVal)) return; // no change, skip animation
    el.dataset.lastVal = String(newVal);
    el.classList.remove("count-pulse");
    void el.offsetWidth; // restart animation
    el.classList.add("count-pulse");
  }

  function renderCounters() {
    const cntP = document.getElementById("cntProgrammes");
    const cntS = document.getElementById("cntStudents");
    const cntT = document.getElementById("cntTeams"); // may not exist \u2014 Team Standings card shows "Live" instead of a count now
    if (cntP) { cntP.textContent = state.events.length; pulseCounter(cntP, state.events.length); }
    if (cntS) { cntS.textContent = state.students.length; pulseCounter(cntS, state.students.length); }
    if (cntT) { cntT.textContent = state.teams.length; pulseCounter(cntT, state.teams.length); }
    const catCount = document.getElementById("exploreCategoryCount");
    const partCount = document.getElementById("exploreParticipantCount");
    if (catCount) catCount.textContent = state.categories.length;
    if (partCount) partCount.textContent = state.students.length;
  }

  /* ---------------- team points / leaderboard ---------------- */
  function computeTeamPoints() {
    const pts = {};
    state.teams.forEach((t) => (pts[t.id] = 0));
    Object.entries(state.results).forEach(([, r]) => {
      ["first", "second", "third"].forEach((rank) => {
        const entry = r && r[rank];
        if (!entry) return;
        const ids = entry.tiedIds && entry.tiedIds.length ? entry.tiedIds : [entry.studentId];
        ids.forEach((studentId) => {
          const st = state.students.find((s) => s.id === studentId);
          if (st) pts[st.team] = (pts[st.team] || 0) + RANK_POINTS[rank];
        });
      });
    });
    return pts;
  }

  function renderLeaderboard() {
    const pts = computeTeamPoints();
    const sorted = [...state.teams].sort((a, b) => (pts[b.id] || 0) - (pts[a.id] || 0));
    const maxPts = Math.max(1, ...sorted.map((t) => pts[t.id] || 0));

    // Top scorer card
    const topScorerEl = document.getElementById("lrTopScorer");
    if (topScorerEl) {
      const top = sorted[0];
      topScorerEl.innerHTML = top ? `
        <div class="lr-top-card">
          <div class="lr-trophy" style="font-size:2rem;line-height:1">\u{1F3C6}</div>
          <div class="lr-top-info">
            <div class="lr-label">\u2605 TOP SCORER</div>
            <div class="lr-team">${escapeHtml(top.name)}</div>
            <div class="lr-points"><b>${pts[top.id] || 0}</b> Points</div>
          </div>
        </div>` : "";
    }

    // Ranked board
    document.getElementById("leaderboard").innerHTML = sorted.map((t, i) => {
      const rankClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
      const barPct = Math.round(((pts[t.id] || 0) / maxPts) * 100);
      return `
      <div class="lr-board-row">
        <div class="lr-rank ${rankClass}">${i + 1}</div>
        <div class="lr-team-name">${escapeHtml(t.name)}</div>
        <div class="lr-progress-bar"><div class="lr-progress-fill" style="width:${barPct}%"></div></div>
        <div class="lr-points-cell"><div class="lr-num">${pts[t.id] || 0}</div><div class="lr-txt">Points</div></div>
      </div>`;
    }).join("");

    // Stats: completed vs remaining programmes
    const statsEl = document.getElementById("lrStats");
    if (statsEl) {
      const completed = state.events.filter((e) => state.results[e.id]).length;
      const remaining = state.events.length - completed;
      statsEl.innerHTML = `
        <div class="lr-stat-item">
          <div class="lr-stat-icon blue">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z"/></svg>
          </div>
          <div class="lr-stat-value blue">${completed} EVENTS</div>
          <div class="lr-stat-label">Completed</div>
        </div>
        <div class="lr-stat-item">
          <div class="lr-stat-icon green">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg>
          </div>
          <div class="lr-stat-value green">${remaining} EVENTS</div>
          <div class="lr-stat-label">Remaining</div>
        </div>`;
    }
  }

  /* ---------------- results portal (search + text list) ---------------- */
  let resultsGender = "Boys";
  const RESULTS_FEED_PAGE_SIZE = 10;
  let resultsFeedPage = 0;
  let expandedResultCard = null;
  let searchResultsShown = 8;
  const SEARCH_RESULTS_PAGE_SIZE = 8;

  // Looks across every published result for a given student and returns
  // any placements (1st/2nd/3rd) they've won, with the programme name.
  function getStudentWins(studentId) {
    const wins = [];
    state.events.forEach((e) => {
      const result = state.results[e.id];
      if (!result) return;
      ["first", "second", "third"].forEach((rank) => {
        const entry = result[rank];
        if (!entry) return;
        const ids = entry.tiedIds && entry.tiedIds.length ? entry.tiedIds : [entry.studentId];
        if (ids.includes(studentId)) wins.push({ eventId: e.id, eventName: e.name, rank });
      });
    });
    return wins;
  }
  document.querySelectorAll("#genderTabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      resultsGender = btn.dataset.gender;
      document.querySelectorAll("#genderTabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
      resultsFeedPage = 0; expandedResultCard = null;
      renderFilters();
      renderResultsList();
    });
  });

  function renderFilters() {
    const catSel = document.getElementById("filterCategory");
    catSel.innerHTML = state.categories.map((c) => `<option value="${c}">${c}</option>`).join("");
    const category = catSel.value || state.categories[0];
    catSel.value = category;

    const evSel = document.getElementById("filterEvent");
    const eligible = state.events.filter((e) => e.category === category && (e.gender === resultsGender || e.gender === "General"));
    evSel.innerHTML = eligible.length
      ? eligible.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("")
      : `<option value="">No programmes</option>`;
  }
  document.getElementById("filterCategory").addEventListener("change", () => { renderFilters(); renderResultsList(); });
  document.getElementById("filterEvent").addEventListener("change", renderResultsList);
  document.getElementById("searchBox").addEventListener("input", renderResultsList);
  document.getElementById("btnResultSearch").addEventListener("click", () => {
    const eventId = document.getElementById("filterEvent").value;
    showResultBlock(eventId);
  });

  // Inline "Result" display for the search filters above — category, item
  // name, and the published winners (rank, name, team) only. No other text.
  function showResultBlock(eventId) {
    const block = document.getElementById("resultBlock");
    const event = state.events.find((e) => e.id === eventId);
    if (!event || !state.results[event.id]) {
      block.classList.add("hidden");
      return showToast(event ? `Results not published yet for ${event.name}` : "Choose a programme first");
    }
    const winners = getWinnersForEvent(event.id);
    if (!winners.length) {
      block.classList.add("hidden");
      return showToast("No winners recorded for this programme yet");
    }

    block.innerHTML = `
      <div class="category">${escapeHtml(event.category)}</div>
      <div class="item-name">${escapeHtml(event.name)}</div>
      ${renderPublicWinnersTable(event.id)}
      <div class="rf-footer" style="margin-top:.75rem">
        <button type="button" class="rf-btn rf-btn-share" id="btnResultBlockShare">\u{1F4AC} Share</button>
        <button type="button" class="rf-btn rf-btn-poster" id="btnResultBlockDownload">\u2B07 Download</button>
      </div>`;
    block.classList.remove("hidden");
    document.getElementById("btnResultBlockShare").addEventListener("click", () => openResultPosterModal(event.id));
    document.getElementById("btnResultBlockDownload").addEventListener("click", () => openResultPosterModal(event.id));
  }

  // Same result view as the search-icon flow (category, item name, winners
  // table, Share + Download) but entered by tapping a student in the name
  // search list instead of picking a programme. If the student has more
  // than one published win, every one of them is shown, each with its own
  // Share / Download.
  function showStudentResultBlock(studentId) {
    const student = state.students.find((s) => s.id === studentId);
    if (!student) return;
    const wins = getStudentWins(studentId);
    const block = document.getElementById("resultBlock");
    if (!wins.length) {
      block.classList.add("hidden");
      return showToast("No published results for this student yet");
    }

    block.innerHTML = wins.map((w, i) => {
      const event = state.events.find((e) => e.id === w.eventId);
      if (!event) return "";
      return `
      <div class="student-result-entry" ${i > 0 ? 'style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border)"' : ""}>
        <div class="category">${escapeHtml(event.category)}</div>
        <div class="item-name">${escapeHtml(event.name)}</div>
        ${renderPublicWinnersTable(event.id)}
        <div class="rf-footer" style="margin-top:.75rem">
          <button type="button" class="rf-btn rf-btn-share" data-share="${event.id}">\u{1F4AC} Share</button>
          <button type="button" class="rf-btn rf-btn-poster" data-download="${event.id}">\u2B07 Download</button>
        </div>
      </div>`;
    }).join("");
    block.classList.remove("hidden");
    block.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => openResultPosterModal(b.dataset.share)));
    block.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => openResultPosterModal(b.dataset.download)));
  }


  function renderResultsList() {
    document.getElementById("resultBlock").classList.add("hidden");
    const search = document.getElementById("searchBox").value.trim().toLowerCase();
    const list = document.getElementById("resultsList");

    if (search) {
      const matches = state.students.filter((s) => s.name.toLowerCase().includes(search) || s.chestNo.toLowerCase().includes(search));
      if (!matches.length) {
        list.innerHTML = `<div class="empty-note">No students found for "${escapeHtml(search)}".</div>`;
        return;
      }
      const visible = matches.slice(0, searchResultsShown);
      list.innerHTML = visible.map((s) => {
        const team = state.teams.find((t) => t.id === s.team);
        const wins = getStudentWins(s.id);
        const winsHtml = wins.length
          ? `<div class="result-wins">${wins.map((w) => `<span class="win-chip">${RANK_ICON[w.rank]} ${RANK_LABEL[w.rank]} \u2014 ${escapeHtml(w.eventName)}</span>`).join("")}</div>`
          : "";
        return `<div class="result-row" data-student="${s.id}" style="flex-direction:column;align-items:stretch;gap:.35rem;cursor:pointer">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:.75rem">
            <div><div class="result-name">${escapeHtml(s.name)}</div><div class="result-meta">${s.chestNo} \u00b7 ${s.category} \u00b7 ${team ? escapeHtml(team.name) : ""}</div></div>
            <div class="result-meta">${s.events.length} events</div>
          </div>
          ${winsHtml}
        </div>`;
      }).join("");
      list.querySelectorAll("[data-student]").forEach((row) => row.addEventListener("click", (e) => {
        e.stopPropagation();
        showStudentResultBlock(row.dataset.student);
      }));
      if (matches.length > searchResultsShown) {
        list.innerHTML += `<button type="button" class="btn btn-ghost" id="btnViewNextSearch" style="width:100%;margin-top:.6rem">View Next</button>`;
        const btn = document.getElementById("btnViewNextSearch");
        if (btn) btn.addEventListener("click", () => { searchResultsShown += SEARCH_RESULTS_PAGE_SIZE; renderResultsList(); });
      }
      return;
    }

    searchResultsShown = SEARCH_RESULTS_PAGE_SIZE;
    renderResultsFeed();
  }

  // Clicking outside the results/search section resets the search box and
  // collapses back to the default published-results feed. Also closes the
  // search-icon result block (#resultBlock), which never auto-closed before.
  document.addEventListener("click", (e) => {
    const section = document.getElementById("results");
    const searchBoxEl = document.getElementById("searchBox");
    const block = document.getElementById("resultBlock");
    if (!section || !searchBoxEl) return;
    if (!section.contains(e.target)) {
      if (searchBoxEl.value.trim()) {
        searchBoxEl.value = "";
        searchResultsShown = SEARCH_RESULTS_PAGE_SIZE;
        renderResultsList();
      }
      if (block && !block.classList.contains("hidden")) block.classList.add("hidden");
    }
  });

  // Clicking outside an expanded result card collapses it back down.
  document.addEventListener("click", (e) => {
    if (expandedResultCard && !e.target.closest(`.rf-card[data-event="${expandedResultCard}"]`)) {
      expandedResultCard = null;
      renderResultsFeed();
    }
  });

  // Published-results feed shown on the home page by default (no search text).
  // Every published event's winners live permanently in state.results (Firebase),
  // so this feed and every card in it stays searchable/downloadable at any time —
  // nothing here ever expires or disappears after a single view.
  function getPublishedResultEvents() {
    return state.events.filter((e) => state.results[e.id] && (e.gender === resultsGender || e.gender === "General"));
  }

  function renderResultsFeed() {
    const list = document.getElementById("resultsList");
    const pager = document.getElementById("resultsPagination");
    const events = getPublishedResultEvents();

    if (!events.length) {
      list.innerHTML = `<div class="empty-note">No results published yet.</div>`;
      if (pager) pager.innerHTML = "";
      return;
    }

    const totalPages = Math.max(1, Math.ceil(events.length / RESULTS_FEED_PAGE_SIZE));
    if (resultsFeedPage >= totalPages) resultsFeedPage = totalPages - 1;
    if (resultsFeedPage < 0) resultsFeedPage = 0;
    const pageEvents = events.slice(resultsFeedPage * RESULTS_FEED_PAGE_SIZE, resultsFeedPage * RESULTS_FEED_PAGE_SIZE + RESULTS_FEED_PAGE_SIZE);

    list.innerHTML = pageEvents.map((event) => {
      const winners = getWinnersForEvent(event.id);
      if (!winners.length) return "";

      const first = winners[0];
      const expanded = expandedResultCard === event.id;

      return `
      <div class="rf-card ${expanded ? "expanded" : ""}" data-event="${event.id}">
        <div class="rf-header" data-toggle="${event.id}">
          <div class="rf-top-row">
            <div class="rf-badge-category">${escapeHtml(event.category)}</div>
            <h2 class="rf-title">${escapeHtml(event.name)}</h2>
          </div>
          <span class="rf-chevron">\u25BC</span>
        </div>
        ${expanded ? `
        <div class="rf-winners-list">
          ${renderPublicWinnersTable(event.id)}
        </div>
        <div class="rf-footer">
          <button class="rf-btn rf-btn-share" data-share="${event.id}">\u{1F4AC} Share</button>
          <button class="rf-btn rf-btn-poster" data-poster="${event.id}">\u2B07 Poster</button>
        </div>` : ""}
      </div>`;
    }).join("");

    list.querySelectorAll("[data-toggle]").forEach((el) => el.addEventListener("click", () => {
      const id = el.dataset.toggle;
      expandedResultCard = expandedResultCard === id ? null : id;
      renderResultsFeed();
    }));
    list.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openResultPosterModal(b.dataset.share); }));
    list.querySelectorAll("[data-poster]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openResultPosterModal(b.dataset.poster); }));

    if (pager) {
      if (totalPages <= 1) { pager.innerHTML = ""; }
      else {
        pager.innerHTML = `
          <button type="button" class="rf-page-btn" id="rfPrev" ${resultsFeedPage === 0 ? "disabled" : ""} aria-label="Previous page">&#171;</button>
          <span class="rf-page-info">${resultsFeedPage + 1} / ${totalPages}</span>
          <button type="button" class="rf-page-btn" id="rfNext" ${resultsFeedPage >= totalPages - 1 ? "disabled" : ""} aria-label="Next page">&#187;</button>`;
        const prevBtn = document.getElementById("rfPrev");
        const nextBtn = document.getElementById("rfNext");
        if (prevBtn) prevBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); resultsFeedPage--; expandedResultCard = null; renderResultsFeed(); });
        if (nextBtn) nextBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); resultsFeedPage++; expandedResultCard = null; renderResultsFeed(); });
      }
    }
  }

  // (Removed: quickDownloadResult/quickShareResult, which used to share/download
  // straight from the feed with no way to pick a template first \u2014 every entry
  // point now opens openResultPosterModal instead, template picker included.)

  /* ---------------- poster templates (canvas) ---------------- */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // needed to canvas-process images hosted on ImgBB etc.
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Turns any image URL (including a remote ImgBB link) into a local data: URL
  // by drawing it through a canvas. Browsers ignore the `download` attribute
  // and can't attach cross-origin files to the share sheet, so anything we
  // download/share gets normalized through here first.
  function toLocalDataUrl(url) {
    if (url && url.startsWith("data:")) return Promise.resolve(url);
    return loadImage(url).then((img) => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.92);
    });
  }

  function dataUrlToFile(dataUrl, filename) {
    const [header, base64] = dataUrl.split(",");
    const mime = header.match(/:(.*?);/)[1];
    const bytes = atob(base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new File([arr], filename, { type: mime });
  }

  // Shares an image + caption together as one native share-sheet action (so
  // WhatsApp gets both the photo and the text, not just a text link). Falls
  // back to downloading the photo and opening WhatsApp's text composer on
  // browsers/devices where file-sharing isn't supported.
  async function shareBlobFile(blob, filename, mimeType, text) {
    if (navigator.canShare) {
      try {
        const file = new File([blob], filename, { type: mimeType });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled the share sheet
      }
    }
    const url = URL.createObjectURL(blob);
    downloadDataUrl(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function shareImageWithText(dataUrl, filename, text) {
    if (navigator.canShare) {
      try {
        const file = dataUrlToFile(dataUrl, filename);
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled the share sheet
      }
    }
    downloadDataUrl(dataUrl, filename);
    showToast("Photo downloaded \u2014 attach it manually in the WhatsApp chat that just opened");
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  }

  // Cover-fits the photo to the frame's canvas size, then draws the
  // transparent-centre PNG frame on top so the photo shows through the
  // frame's opening while its decorative border stays fixed.
  function compositeWithFrame(photoDataUrl) {
    const frameUrl = state.hero.galleryFrameUrl;
    if (!frameUrl) return Promise.resolve(photoDataUrl);
    return Promise.all([loadImage(photoDataUrl), loadImage(frameUrl)]).then(([photo, frame]) => {
      const canvas = document.createElement("canvas");
      canvas.width = frame.width; canvas.height = frame.height;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(canvas.width / photo.width, canvas.height / photo.height);
      const w = photo.width * scale, h = photo.height * scale;
      ctx.drawImage(photo, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.9);
    });
  }

  // Frame is applied only when the guest actually downloads/shares a photo —
  // not baked into the stored photo — so the gallery itself always shows the
  // clean original, and admin can turn framing off/on any time without
  // needing to re-upload anything.
  function getFramedPhotoUrl(photo) {
    const shouldFrame = state.hero.galleryFrameUrl && state.hero.applyFrameOnDownload !== false;
    if (shouldFrame) return compositeWithFrame(photo.url);
    return toLocalDataUrl(photo.url);
  }

  function drawTextBlock(ctx, cx, y, color, rankLabel, line1, line2, line3) {
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.65)"; ctx.shadowBlur = 12;
    ctx.fillStyle = color; ctx.font = "bold 34px Georgia"; ctx.fillText(rankLabel, cx, y);
    ctx.font = "bold 60px Georgia"; ctx.fillText(line1, cx, y + 74);
    ctx.font = "31px Georgia"; ctx.fillText(line2, cx, y + 130);
    ctx.font = "26px Georgia"; ctx.fillText(line3, cx, y + 173);
    ctx.shadowBlur = 0;
  }

  // Returns a Promise<dataURL>. Poster templates are madrasa-designed images
  // (uploaded via Admin → Poster Templates) — we cover-fit the image onto a
  // fixed 1080x1350 canvas and print the winner's name/rank/team on top at
  // the position the admin configured (textY / textColor per template).
  function drawPoster(payload, templateOverride) {
    const template = templateOverride || state.hero.posterTemplate;
    const { rankLabel, line1, line2, line3 } = payload;
    const custom = template ? state.customTemplates.find((ct) => ct.id === template) : null;

    const canvas = document.createElement("canvas");
    canvas.width = 1080; canvas.height = 1350;
    const ctx = canvas.getContext("2d");

    if (custom && custom.imageUrl) {
      return loadImage(custom.imageUrl).then((img) => {
        // cover-fit the uploaded template image into the poster canvas
        const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        const y = canvas.height * ((custom.textY || 78) / 100);
        drawTextBlock(ctx, canvas.width / 2, y, custom.textColor || "#FFFFFF", rankLabel, line1, line2, line3);
        return canvas.toDataURL("image/jpeg", 0.92);
      });
    }

    // Fallback so nothing breaks if no template has been uploaded yet —
    // not offered as a selectable "design", just a plain safety net.
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, "#0B3D2E"); grad.addColorStop(1, "#0A2A20");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#C9A227"; ctx.lineWidth = 6; ctx.strokeRect(36, 36, canvas.width - 72, canvas.height - 72);
    ctx.textAlign = "center";
    ctx.fillStyle = "#FAF6EC"; ctx.font = "bold 44px Georgia"; ctx.fillText(state.hero.title, canvas.width / 2, 300);
    drawTextBlock(ctx, canvas.width / 2, canvas.height * 0.6, "#E4C767", rankLabel, line1, line2, line3);
    return Promise.resolve(canvas.toDataURL("image/png"));
  }

  // Combined result poster: 1st, 2nd & 3rd winners of one programme, laid out
  // as a fixed 1080x1350 (portrait) design matching the approved reference
  // design/coordinates exactly (category, programme name, rank number,
  // winner name & team for each of the top 3). The festival name is not
  // drawn here \u2014 it's already part of the template graphic itself.
  function ordinalSuffix(n) {
    if (n === 1) return "st"; if (n === 2) return "nd"; if (n === 3) return "rd"; return "th";
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function getAllResultTemplates() {
    return state.resultTemplates.map((t) => ({ id: t.id, imageUrl: t.imageUrl }));
  }

  // Result poster: category + programme name + top-3 winners, drawn on top
  // of an admin-uploaded 1080x1350 background image (art/photo, uploaded via
  // Admin \u2192 Home \u2192 Result Templates). Falls back to a plain light
  // background if nothing has been uploaded yet. Every text field (category,
  // programme name, rank ordinal, winner name, team) is filled in
  // automatically from the event/winners data at generation time.
  function drawResultPoster(event, winners, templateOverride) {
    const template = templateOverride || state.hero.resultTemplate;
    let custom = template ? state.resultTemplates.find((rt) => rt.id === template) : null;
    // Fall back to the first uploaded template if none is marked active yet
    // (e.g. an older upload from before templates auto-selected themselves).
    if (!custom && state.resultTemplates.length) custom = state.resultTemplates[0];

    const canvas = document.createElement("canvas");
    canvas.width = 1080; canvas.height = 1350;
    const ctx = canvas.getContext("2d");
    const CW = canvas.width, CH = canvas.height;

    const paintWinners = () => {
      const PAD_L = 90, PAD_TOP = 140;
      ctx.textAlign = "left";
      ctx.fillStyle = "#F4A22A"; ctx.font = "600 56px Poppins, sans-serif";
      ctx.fillText(event.category || "", PAD_L, PAD_TOP + 56 * 0.85);

      ctx.fillStyle = "#fff"; ctx.font = "700 78px Poppins, sans-serif";
      ctx.fillText(event.name || "", PAD_L, PAD_TOP + 56 + 8 + 78 * 0.85);

      const BOX = 120, RADIUS = 26, ROW_GAP = 50, DETAILS_LEFT = PAD_L + BOX + 40;
      const ROW_H = BOX + ROW_GAP;
      const WINNERS_TOP = 350;
      const ROW_TOP = [WINNERS_TOP, WINNERS_TOP + ROW_H, WINNERS_TOP + ROW_H * 2];

      winners.slice(0, 3).forEach((w, i) => {
        const top = ROW_TOP[i];
        const centerY = top + BOX / 2;

        ctx.fillStyle = "#F4A22A";
        roundedRectPath(ctx, PAD_L, top, BOX, BOX, RADIUS);
        ctx.fill();

        ctx.fillStyle = "#000";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.font = "700 56px Poppins, sans-serif";
        const numW = ctx.measureText(String(i + 1)).width;
        const numX = PAD_L + BOX / 2 - (numW + 24) / 2;
        ctx.fillText(String(i + 1), numX, centerY + 3);
        ctx.font = "600 30px Poppins, sans-serif";
        ctx.fillText(ordinalSuffix(i + 1), numX + numW + 2, centerY - 16);
        ctx.textBaseline = "alphabetic";

        ctx.fillStyle = "#fff"; ctx.font = "700 48px Poppins, sans-serif";
        ctx.fillText(w.student.name || "", DETAILS_LEFT, centerY - 4);

        ctx.fillStyle = "#fff"; ctx.font = "italic 500 34px Poppins, sans-serif";
        ctx.fillText(w.team ? w.team.name : "", DETAILS_LEFT, centerY + 44);
      });
    };

    if (custom && custom.imageUrl) {
      return loadImage(custom.imageUrl).then((img) => {
        const scale = Math.max(CW / img.width, CH / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (CW - w) / 2, (CH - h) / 2, w, h);
        paintWinners();
        return canvas.toDataURL("image/jpeg", 0.92);
      });
    }

    // No template uploaded yet — plain light background so it still works.
    ctx.fillStyle = "#F2F2F2"; ctx.fillRect(0, 0, CW, CH);
    const glow = ctx.createRadialGradient(CW + 78, -84, 0, CW + 78, -84, 960);
    glow.addColorStop(0, "rgba(255,255,255,0.8)");
    glow.addColorStop(0.7, "rgba(242,242,242,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(CW + 78, -84, 960, 0, Math.PI * 2); ctx.fill();
    paintWinners();
    return Promise.resolve(canvas.toDataURL("image/png"));
  }


  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement("a");
    a.href = dataUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    });
    if (line) lines.push(line);
    return lines;
  }

  /* ---- Chest Number Card (single master template) ----
     One admin-designed portrait template (1080x2337px) with placeholder
     tags positioned anywhere on it. Tags are resolved from each student's
     data at generation time \u2014 no per-template colour or text-position
     setup needed, and there is only ever one template. */
  const CARD_TAGS = [
    { key: "student_name", label: "Name", sample: "QALEELULLA CH" },
    { key: "chest_number", label: "Chest No", sample: "303" },
    { key: "category", label: "Category", sample: "Junior" },
    { key: "school_class", label: "Class", sample: "7-A" },
    { key: "team_name", label: "Team", sample: "Majriyya" },
  ];

  // Fixed default layout applied automatically whenever a template image is
  // uploaded \u2014 there is no manual drag/position editor any more. Matches
  // the approved reference design: a right-anchored, center-aligned text
  // stack (name wrapped one word per line, then chest no / category / team),
  // all in black, no name banner and no QR code.
  function defaultCardPlacements() {
    return [
      { id: "pl-" + uid(), tag: "student_name", xPct: 69, yPct: 35, fontSize: 46, weight: 700, color: "#fff" },
      { id: "pl-" + uid(), tag: "chest_number", fontSize: 47, weight: 600, color: "#fff" },
      { id: "pl-" + uid(), tag: "category", fontSize: 47, weight: 600, color: "#fff" },
      { id: "pl-" + uid(), tag: "team_name", fontSize: 36, weight: 400, color: "#fff" },
    ];
  }

  function resolveCardTag(tag, student) {
    switch (tag) {
      case "student_name": return student.name || "";
      case "chest_number": return String(student.chestNo || "");
      case "category": return student.category || "";
      case "school_class": return student.cls || "";
      case "team_name": { const t = state.teams.find((tm) => tm.id === student.team); return t ? t.name : ""; }
      default: return "";
    }
  }

  // Renders one student's card onto canvas using the master template image
  // plus every placed tag. Returns a Promise<dataURL>.
  function drawMasterCard(student) {
    const mt = state.masterCardTemplate || { imageUrl: null, placements: [] };
    const canvas = document.createElement("canvas");
    canvas.width = 1013; canvas.height = 638;
    const ctx = canvas.getContext("2d");
    const CW = canvas.width, CH = canvas.height;

    const templatePromise = mt.imageUrl ? loadImage(mt.imageUrl) : Promise.resolve(null);

    return templatePromise.then((img) => {
      if (img) {
        const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      } else {
        ctx.fillStyle = "#F0F0F0"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      const placements = mt.placements && mt.placements.length ? mt.placements : defaultCardPlacements();
      const PAD_RIGHT = 160;
      const GAP = 32;
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";

      // Name is pinned to its own fixed spot on the template (the red box in
      // the artwork) instead of sharing the auto-centered block below, so it
      // lines up with that box regardless of how wide the other fields are.
      const namePlacement = placements.find((p) => p.tag === "student_name");
      let nameBottom = CH * 0.4;
      if (namePlacement) {
        const nameVal = resolveCardTag("student_name", student);
        if (nameVal) {
          const font = `${namePlacement.weight || 700} ${namePlacement.fontSize || 46}px Rajdhani, Poppins, sans-serif`;
          ctx.font = font; ctx.fillStyle = namePlacement.color || "#fff";
          const words = nameVal.toUpperCase().split(" ");
          const lineHeight = (namePlacement.fontSize || 46) * 1.2;
          const nx = ((namePlacement.xPct || 64) / 100) * CW, ny = ((namePlacement.yPct || 36) / 100) * CH;
          const startY = ny - ((words.length - 1) * lineHeight) / 2;
          words.forEach((word, i) => ctx.fillText(word, nx, startY + i * lineHeight + namePlacement.fontSize * 0.3));
          nameBottom = ny + (words.length * lineHeight) / 2;
        }
      }

      // Chest No / Category / Team stack right below the name, right-anchored.
      const restPlacements = placements.filter((p) => p.tag !== "student_name");
      const lines = [];
      restPlacements.forEach((p) => {
        const val = resolveCardTag(p.tag, student);
        if (!val) return;
        const font = `${p.weight || 600} ${p.fontSize || 40}px Rajdhani, Poppins, sans-serif`;
        const uppercase = p.tag !== "chest_number";
        lines.push({ text: uppercase ? val.toUpperCase() : val, font, fontSize: p.fontSize || 40, color: p.color || "#fff", lineHeight: (p.fontSize || 40) * 1.2, gapBefore: GAP });
      });
      if (lines.length) lines[0].gapBefore = 0;

      let maxWidth = 0;
      lines.forEach((l) => { ctx.font = l.font; maxWidth = Math.max(maxWidth, ctx.measureText(l.text).width); });
      const centerX = CW - PAD_RIGHT - maxWidth / 2;

      let y = nameBottom + 20;
      lines.forEach((l) => {
        y += l.gapBefore;
        ctx.font = l.font; ctx.fillStyle = l.color;
        ctx.fillText(l.text, centerX, y + l.fontSize * 0.85);
        y += l.lineHeight;
      });

      return canvas.toDataURL("image/jpeg", 0.92);
    });
  }

  // Builds a combined, printable PDF of every student's card in a category.
  function generateMasterCardsPdf(category, perPage) {
    if (!category) return showToast("Choose a category first");
    const students = state.students.filter((s) => s.category === category);
    if (!students.length) return showToast("No students found in this category");
    if (!window.jspdf) return showToast("PDF library failed to load \u2014 check your connection and try again");
    if (!state.masterCardTemplate || !state.masterCardTemplate.imageUrl) return showToast("Upload a master template first (Super Admin \u2192 Chest Number)");
    showToast(`Preparing ${students.length} card${students.length > 1 ? "s" : ""}\u2026`);

    return Promise.all(students.map((s) => drawMasterCard(s))).then((urls) => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const pageW = 210, pageH = 297, margin = 10;
      const ratio = 1013 / 638;

      let cols, rows, gapX, gapY;
      if (perPage === 12) { cols = 3; rows = 4; gapX = 6; gapY = 6; }
      else { cols = 2; rows = 4; gapX = 8; gapY = 8; } // 8 per page \u2014 larger, more legible

      const cardW = (pageW - margin * 2 - gapX * (cols - 1)) / cols;
      const cardH = cardW / ratio;
      const totalW = cols * cardW + (cols - 1) * gapX;
      const totalH = rows * cardH + (rows - 1) * gapY;
      const startX = (pageW - totalW) / 2;
      const startY = (pageH - totalH) / 2;
      const perPageCount = cols * rows;

      urls.forEach((url, i) => {
        const posInPage = i % perPageCount;
        if (i > 0 && posInPage === 0) doc.addPage();
        const col = posInPage % cols;
        const row = Math.floor(posInPage / cols);
        const x = startX + col * (cardW + gapX);
        const y = startY + row * (cardH + gapY);
        doc.addImage(url, "JPEG", x, y, cardW, cardH);
      });

      showToast(`${students.length} card${students.length > 1 ? "s" : ""} ready`);
      return { blob: doc.output("blob"), filename: `${category.replace(/\s+/g, "_")}-chest-no-cards.pdf`, count: students.length };
    }).catch((err) => { showToast("Could not prepare the PDF"); throw err; });
  }

  // Opens the shared #printOverlay with every card in the category laid out
  // as real <img> tags (crisper for browser printing than a re-rasterised PDF).
  //
  // Bug fix: cards used to be embedded as raw base64 data: URLs straight from
  // canvas.toDataURL(). With 8-12 full-resolution cards on one page that's
  // several MB of inline text in the DOM, and mobile Chrome's print renderer
  // silently produces a blank page when a print job's inline image payload
  // gets too large \u2014 it doesn't error, it just prints nothing. Converting
  // each data URL to a Blob object URL keeps the exact same image data but
  // as a tiny memory reference in the HTML instead of megabytes of inline
  // text, which is what the print renderer was choking on.
  function openBulkCardPrintSheet(category, perPage) {
    const students = state.students.filter((s) => s.category === category);
    if (!students.length) return showToast("No students found in this category");
    if (!state.masterCardTemplate || !state.masterCardTemplate.imageUrl) return showToast("Upload a master template first (Super Admin \u2192 Chest Number)");
    showToast(`Preparing ${students.length} card${students.length > 1 ? "s" : ""} for print\u2026`);
    Promise.all(students.map((s) => drawMasterCard(s)))
      .then((dataUrls) => Promise.all(dataUrls.map((u) => fetch(u).then((r) => r.blob()).then((b) => URL.createObjectURL(b)))))
      .then((blobUrls) => {
        const gridClass = perPage === 12 ? "bulk-card-print-grid per-page-12" : "bulk-card-print-grid per-page-8";
        const pages = [];
        for (let i = 0; i < blobUrls.length; i += perPage) pages.push(blobUrls.slice(i, i + perPage));
        const pagesHtml = pages.map((pageUrls, pi) => {
          const cardsHtml = pageUrls.map((u) => `<img src="${u}" class="bulk-card-print-img" />`).join("");
          const cls = gridClass + (pi === 0 ? "" : " page-break print-page-hidden");
          const gridDiv = `<div class="${cls}">${cardsHtml}</div>`;
          if (pi === 0) return gridDiv;
          return `<div class="bulk-print-page-summary"><span class="chev">\u203a\u203a</span> Page ${pi + 1} \u2014 ${pageUrls.length} card${pageUrls.length > 1 ? "s" : ""} ready, prints automatically <span class="chev">\u2039\u2039</span></div>${gridDiv}`;
        }).join("");
        document.getElementById("printTitle").textContent = "Chest Number Cards";
        document.getElementById("printContent").innerHTML = pagesHtml;
        document.getElementById("printOverlay").classList.remove("hidden");
        pushScreen(() => {
          document.getElementById("printOverlay").classList.add("hidden");
          blobUrls.forEach((u) => URL.revokeObjectURL(u));
        });
      }).catch(() => showToast("Could not prepare cards for print"));
  }


  /* ---------------- victory poster modal ---------------- */
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");
  function closeModal() { modalOverlay.classList.add("hidden"); modalBody.innerHTML = ""; }
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeTopScreen(); });

  const posterScreen = document.getElementById("posterScreen");
  const posterScreenContent = document.getElementById("posterScreenContent");
  function closePosterScreen() { posterScreen.classList.add("hidden"); document.body.classList.remove("no-scroll"); }
  function openPosterScreen(title) {
    document.getElementById("posterScreenTitle").textContent = title;
    document.body.classList.add("no-scroll");
    posterScreen.classList.remove("hidden");
    pushScreen(closePosterScreen);
  }
  document.getElementById("btnPosterScreenBack").addEventListener("click", closeTopScreen);

  function openPosterModal({ student, rank, event, team }) {
    const templates = getAllTemplates();
    let selectedTemplate = templates.some((t) => t.id === state.hero.posterTemplate)
      ? state.hero.posterTemplate : (templates[0] ? templates[0].id : null);

    const cardHtml = (t) => `
      <div class="poster-card ${t.id === selectedTemplate ? "active" : ""}" data-tpl="${t.id}" style="background-image:url('${t.imageUrl}')">
        <div class="poster-card-overlay" style="top:${t.textY || 78}%;color:${t.textColor || "#fff"}">
          <div class="poster-card-rank">${RANK_LABEL[rank]}</div>
          <div class="poster-card-name">${escapeHtml(student.name)}</div>
          <div class="poster-card-code">${student.chestNo}</div>
          <div class="poster-card-team">${escapeHtml(team.name)}</div>
        </div>
      </div>`;

    posterScreenContent.innerHTML = `
      <div class="poster-head arch-top">
        <div style="font-size:1.4rem;color:var(--gold)">\u2605</div>
        <div class="poster-rank">${RANK_LABEL[rank]}</div>
        <div class="poster-name font-display">${escapeHtml(student.name)}</div>
        <div class="poster-code">${student.chestNo}</div>
        <div class="poster-event">${escapeHtml(event.name)} \u00b7 ${escapeHtml(team.name)}</div>
      </div>
      ${templates.length ? `
        <div class="field-label" style="padding:.85rem 1rem 0;background:var(--surface)">Swipe to choose a poster design</div>
        <div class="poster-carousel" id="posterCarousel">${templates.map(cardHtml).join("")}</div>
      ` : `
        <div class="empty-note" style="margin:1rem">No poster template has been added yet. Ask your madrasa admin to add one under Admin \u2192 Home Page \u2192 Poster Templates.</div>
      `}
      <div class="modal-actions">
        <button class="btn btn-primary" id="btnDownloadPoster">\u2B07 Download Poster</button>
        <button class="btn btn-whatsapp" id="btnSharePoster">\u{1F4AC} Share</button>
      </div>`;
    openPosterScreen(`${RANK_LABEL[rank]} \u2014 ${event.name}`);

    const carousel = document.getElementById("posterCarousel");
    if (carousel) {
      const cards = () => Array.from(carousel.querySelectorAll(".poster-card"));
      const setActive = (tpl) => {
        selectedTemplate = tpl;
        cards().forEach((c) => c.classList.toggle("active", c.dataset.tpl === tpl));
      };
      cards().forEach((c) => c.addEventListener("click", () => {
        c.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        setActive(c.dataset.tpl);
      }));
      let scrollTimer;
      carousel.addEventListener("scroll", () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const mid = carousel.scrollLeft + carousel.clientWidth / 2;
          let closest = null, closestDist = Infinity;
          cards().forEach((c) => {
            const dist = Math.abs((c.offsetLeft + c.offsetWidth / 2) - mid);
            if (dist < closestDist) { closestDist = dist; closest = c; }
          });
          if (closest) setActive(closest.dataset.tpl);
        }, 100);
      }, { passive: true });
    }

    document.getElementById("btnDownloadPoster").addEventListener("click", () => {
      if (!selectedTemplate) return showToast("No poster template added yet");
      showToast("Preparing poster\u2026");
      drawPoster({
        rankLabel: RANK_LABEL[rank],
        line1: student.name, line2: student.chestNo, line3: team.name,
      }, selectedTemplate).then((url) => {
        downloadDataUrl(url, `${student.chestNo}-${rank}.png`);
        showToast("Poster downloaded");
      }).catch(() => showToast("Could not generate poster"));
    });
    document.getElementById("btnSharePoster").addEventListener("click", () => {
      if (!selectedTemplate) return showToast("No poster template added yet");
      showToast("Preparing poster\u2026");
      const text = `Alhamdulillah! ${student.name} (${student.chestNo}) secured ${RANK_LABEL[rank]} in ${event.name} at ${state.hero.title}, representing ${team.name}!\n\nCongratulations!\n\nCheck More Results :\n${window.location.origin}\n\u00a9 Event crew`;
      drawPoster({
        rankLabel: RANK_LABEL[rank],
        line1: student.name, line2: student.chestNo, line3: team.name,
      }, selectedTemplate).then((url) => shareImageWithText(url, `${student.chestNo}-${rank}.jpg`, text))
        .catch(() => showToast("Could not generate poster"));
    });
    document.getElementById("btnClosePoster").addEventListener("click", closeTopScreen);
  }

  // ---- Participant Dashboard: chest-number login gate, then a personal
  // programmes/results view. Full-page screens (same pattern as Admin Mode),
  // not a modal \u2014 so it feels like its own section of the app. ----
  const studentLoginScreen = document.getElementById("studentLoginScreen");
  const studentDashboardScreen = document.getElementById("studentDashboardScreen");
  function closeStudentLoginScreen() { studentLoginScreen.classList.add("hidden"); document.body.classList.remove("no-scroll"); }
  function closeStudentDashboardScreen() { studentDashboardScreen.classList.add("hidden"); document.body.classList.remove("no-scroll"); }

  // Session persists in localStorage so returning to My Profile skips the
  // chest-number prompt until the participant explicitly taps Logout.
  const SD_SESSION_KEY = "meelad_student_session";
  function sdSavedChestNo() { try { return localStorage.getItem(SD_SESSION_KEY); } catch { return null; } }
  function sdSaveSession(chestNo) { try { localStorage.setItem(SD_SESSION_KEY, String(chestNo)); } catch {} }
  function sdClearSession() { try { localStorage.removeItem(SD_SESSION_KEY); } catch {} }

  function openStudentLogin() {
    const saved = sdSavedChestNo();
    const student = saved ? state.students.find((s) => String(s.chestNo) === saved) : null;
    if (student) return openStudentDashboard(student);
    document.body.classList.add("no-scroll");
    document.getElementById("sdChestInput").value = "";
    document.getElementById("sdLoginError").classList.add("hidden");
    studentLoginScreen.classList.remove("hidden");
    pushScreen(closeStudentLoginScreen);
  }

  document.getElementById("btnStudentLoginCancel").addEventListener("click", closeTopScreen);
  document.getElementById("btnStudentDashBack").addEventListener("click", closeTopScreen);
  document.getElementById("btnStudentDashClose").addEventListener("click", () => {
    sdClearSession();
    closeTopScreen();
  });
  (function () {
    const submit = () => {
      const val = document.getElementById("sdChestInput").value.trim();
      const err = document.getElementById("sdLoginError");
      if (!val) { err.textContent = "Enter your chest number"; err.classList.remove("hidden"); return; }
      const student = state.students.find((s) => String(s.chestNo) === val);
      if (!student) { err.textContent = "No participant found with that chest number"; err.classList.remove("hidden"); return; }
      sdSaveSession(student.chestNo);
      openStudentDashboard(student);
    };
    document.getElementById("btnStudentLogin").addEventListener("click", submit);
    document.getElementById("sdChestInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  })();

  function openStudentDashboard(student) {
    const team = state.teams.find((t) => t.id === student.team);
    const events = student.events.map((id) => state.events.find((e) => e.id === id)).filter(Boolean);
    const wins = getStudentWins(student.id);
    const completed = events.filter((e) => state.results[e.id]).length;
    const totalPoints = wins.reduce((sum, w) => sum + (RANK_POINTS[w.rank] || 0), 0);
    const initials = student.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();

    const statCard = (icon, label, value) => `
      <div class="sd-stat-card">
        <div class="sd-stat-icon">${icon}</div>
        <div><div class="sd-stat-value">${value}</div><div class="sd-stat-label">${label}</div></div>
      </div>`;

    const eventRow = (e) => {
      const published = !!state.results[e.id];
      const label = published ? "RESULT OUT" : (e.status === "ticked" ? "COMPLETED" : "UPCOMING");
      const cls = published ? "sd-chip-out" : e.status === "ticked" ? "sd-chip-done" : "sd-chip-upcoming";
      return `<div class="sd-row">
        <div><div class="sd-row-title">${escapeHtml(e.name)}</div><div class="sd-row-sub">${e.type} \u00b7 ${e.stageType || "Stage"}</div></div>
        <span class="sd-chip ${cls}">${label}</span>
      </div>`;
    };

    const resultRow = (w, i) => `<tr>
        <td>${i + 1}. ${escapeHtml(w.eventName)}</td>
        <td style="text-align:center">${RANK_ICON[w.rank] || ""}</td>
        <td style="text-align:center;font-weight:600">${RANK_LABEL[w.rank] || ""}</td>
        <td style="text-align:center;font-weight:700">${RANK_POINTS[w.rank] || 0}</td>
      </tr>`;

    document.getElementById("studentDashboardContent").innerHTML = `
      <div class="sd-profile-card">
        <div class="sd-avatar">${initials}</div>
        <div class="sd-profile-info">
          <p><span class="sd-label">STUDENT:</span> ${escapeHtml(student.name)}</p>
          <p><span class="sd-label">CHEST NUMBER:</span> ${student.chestNo}</p>
          <p><span class="sd-label">TEAM:</span> ${team ? escapeHtml(team.name) : "\u2014"}</p>
          <p><span class="sd-label">CATEGORY:</span> ${escapeHtml(student.category)}</p>
        </div>
        <div class="sd-points-box">
          <div style="font-size:2.2rem">\u{1F3C6}</div>
          <div>
            <div class="sd-points-label">OVERALL POINTS</div>
            <div class="sd-points-value">${totalPoints}</div>
          </div>
        </div>
      </div>

      <div class="sd-stats-grid">
        ${statCard("\u{1F4C5}", "EVENTS REGISTERED", events.length)}
        ${statCard("\u{1F3C5}", "EVENTS COMPLETED", completed)}
        ${statCard("\u2B50", "AWARDS WON", wins.length)}
        ${statCard("\u{1F4CA}", "TOTAL POINTS", totalPoints)}
      </div>

      <div class="sd-two-col">
        <div class="sd-panel">
          <div class="sd-panel-title">MY EVENTS</div>
          <div style="display:flex;flex-direction:column;gap:.45rem">
            ${events.length ? events.map(eventRow).join("") : `<div class="empty-note">No programmes registered yet.</div>`}
          </div>
        </div>
        <div class="sd-panel">
          <div class="sd-panel-title">RESULTS &amp; POINTS</div>
          ${wins.length ? `
          <div class="marks-table-wrap">
            <table class="marks-table"><thead><tr><th style="text-align:left">EVENT</th><th>RANK</th><th>POSITION</th><th>POINTS</th></tr></thead>
            <tbody>${wins.map(resultRow).join("")}</tbody></table>
          </div>` : `<div class="empty-note">No published results yet.</div>`}
        </div>
      </div>`;

    studentLoginScreen.classList.add("hidden");
    studentDashboardScreen.classList.remove("hidden");
    swapTopScreen(closeStudentDashboardScreen);
  }

  const navStudentDashboard = document.getElementById("navStudentDashboard");
  if (navStudentDashboard) navStudentDashboard.addEventListener("click", (e) => {
    e.preventDefault();
    closeSidebar();
    openStudentLogin();
  });

  // Combined result modal: shows 1st, 2nd & 3rd winners of one programme together
  // in a single poster, with a template carousel (admin-managed), download & share.
  function openResultPosterModal(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event) return showToast("Choose a programme first");
    if (!state.results[eventId]) return showToast(`Results not published yet for ${event.name}`);

    const winners = getWinnersForEvent(eventId);
    if (!winners.length) return showToast("No winners recorded for this programme yet");

    const templates = getAllResultTemplates();
    let selectedTemplate = templates.some((t) => t.id === state.hero.resultTemplate)
      ? state.hero.resultTemplate : (templates[0] ? templates[0].id : null);

    posterScreenContent.innerHTML = `
      <div class="poster-head arch-top">
        <div style="font-size:1.4rem;color:var(--gold)">\u{1F3C6}</div>
        <div class="poster-name font-display">${escapeHtml(event.name)}</div>
        <div class="poster-event">${escapeHtml(event.category)}${event.gender !== "General" ? " \u00b7 " + event.gender : ""}</div>
      </div>
      <div id="resultPreviewWrap" style="padding:1rem;display:flex;justify-content:center"><div class="empty-note">Preparing preview\u2026</div></div>
      ${templates.length > 1 ? `
        <div class="field-label" style="padding:.85rem 1rem 0;background:var(--surface)">Choose a result frame design</div>
        <div class="template-row" id="resultTplPickerRow" style="padding:.6rem 1rem">
          ${templates.map((t) => `
            <div class="template-swatch result-template-swatch ${t.id === selectedTemplate ? "selected" : ""}" data-tpl="${t.id}" style="background:url('${t.imageUrl}') center/cover"></div>
          `).join("")}
        </div>
      ` : ""}
      <div class="modal-actions">
        <button class="btn btn-primary" id="btnDownloadResult">\u2B07 Download Poster</button>
        <button class="btn btn-whatsapp" id="btnShareResult">\u{1F4AC} Share</button>
      </div>`;
    openPosterScreen(`\u{1F3C6} ${event.name}`);

    const renderPreview = () => {
      const wrap = document.getElementById("resultPreviewWrap");
      if (wrap) wrap.innerHTML = `<div class="empty-note">Preparing preview\u2026</div>`;
      drawResultPoster(event, winners, selectedTemplate).then((url) => {
        if (wrap) wrap.innerHTML = `<img src="${url}" style="width:100%;max-width:340px;border-radius:.9rem;box-shadow:0 6px 18px rgba(0,0,0,.35)">`;
      });
    };
    renderPreview();

    const pickerRow = document.getElementById("resultTplPickerRow");
    if (pickerRow) {
      pickerRow.querySelectorAll(".result-template-swatch").forEach((sw) => {
        sw.addEventListener("click", () => {
          selectedTemplate = sw.dataset.tpl;
          pickerRow.querySelectorAll(".result-template-swatch").forEach((s) => s.classList.toggle("selected", s === sw));
          renderPreview();
        });
      });
    }

    document.getElementById("btnDownloadResult").addEventListener("click", () => {
      showToast("Preparing result poster\u2026");
      drawResultPoster(event, winners, selectedTemplate).then((url) => {
        downloadDataUrl(url, `${event.name.replace(/\s+/g, "-")}-result.png`);
        showToast("Result poster downloaded");
      }).catch(() => showToast("Could not generate poster"));
    });
    document.getElementById("btnShareResult").addEventListener("click", () => {
      showToast("Preparing result poster\u2026");
      const summary = winners.map((w) => `${RANK_LABEL[w.rank]}: ${w.student.name} (${w.student.chestNo})`).join(", ");
      const text = `${state.hero.title}\n\nCongratulations!\n\nCheck More Results :\n${window.location.origin}\n\u00a9 Event crew`;
      drawResultPoster(event, winners, selectedTemplate)
        .then((url) => shareImageWithText(url, `${event.name.replace(/\s+/g, "-")}-result.jpg`, text))
        .catch(() => showToast("Could not generate poster"));
    });
  }

  /* ---------------- ID card modal (parent-facing) ---------------- */
  function openCardModal(student) {
    const team = state.teams.find((t) => t.id === student.team);
    const hasTemplate = !!(state.masterCardTemplate && state.masterCardTemplate.imageUrl);

    modalBody.innerHTML = `
      <div class="poster-head arch-top">
        <div style="font-size:1.4rem;color:var(--gold)">\u{1F4B3}</div>
        <div class="poster-name font-display">${escapeHtml(student.name)}</div>
        <div class="poster-code">Chest No: ${student.chestNo}</div>
        <div class="poster-event">${escapeHtml(student.category)} \u00b7 ${team ? escapeHtml(team.name) : ""}</div>
      </div>
      ${hasTemplate ? `
        <div id="cardPreviewWrap" style="padding:1rem;display:flex;justify-content:center"><div class="empty-note">Preparing card\u2026</div></div>
      ` : `
        <div class="empty-note" style="margin:1rem">No chest number card template has been added yet. Ask your madrasa admin to add one under Admin \u2192 Chest Number.</div>
      `}
      <div class="modal-actions">
        <button class="btn btn-primary" id="btnDownloadCard">\u2B07 Download Card</button>
        <button class="btn btn-whatsapp" id="btnShareCard">\u{1F4AC} Share</button>
      </div>
      <button class="modal-close" id="btnCloseCard">Close</button>`;
    modalOverlay.classList.remove("hidden");
    pushScreen(closeModal);

    let cardUrlPromise = null;
    if (hasTemplate) {
      cardUrlPromise = drawMasterCard(student);
      cardUrlPromise.then((url) => {
        const wrap = document.getElementById("cardPreviewWrap");
        if (wrap) wrap.innerHTML = `<img src="${url}" style="max-width:100%;border-radius:.6rem;box-shadow:0 4px 16px rgba(0,0,0,.35)" />`;
      });
    }

    document.getElementById("btnDownloadCard").addEventListener("click", () => {
      if (!hasTemplate) return showToast("No chest number card template has been added yet");
      showToast("Preparing card\u2026");
      (cardUrlPromise || drawMasterCard(student)).then((url) => {
        downloadDataUrl(url, `${student.chestNo}-chest-no-card.jpg`);
        showToast("Card downloaded");
      }).catch(() => showToast("Could not generate card"));
    });
    document.getElementById("btnShareCard").addEventListener("click", () => {
      if (!hasTemplate) return showToast("No chest number card template has been added yet");
      showToast("Preparing card\u2026");
      const text = `${student.name} \u2014 Chest No ${student.chestNo}, ${student.category} at ${state.hero.title}, representing ${team ? team.name : ""}!`;
      (cardUrlPromise || drawMasterCard(student))
        .then((url) => shareImageWithText(url, `${student.chestNo}-chest-no-card.jpg`, text))
        .catch(() => showToast("Could not generate card"));
    });
    document.getElementById("btnCloseCard").addEventListener("click", closeTopScreen);
  }

  /* ---------------- gallery ---------------- */
  const GALLERY_PREVIEW_COUNT = 12;
  let homeGalleryPage = 0;
  function renderGallery() {
    const totalPages = Math.max(1, Math.ceil(state.gallery.length / GALLERY_PREVIEW_COUNT));
    if (homeGalleryPage >= totalPages) homeGalleryPage = totalPages - 1;
    if (homeGalleryPage < 0) homeGalleryPage = 0;
    const pageItems = state.gallery.slice(homeGalleryPage * GALLERY_PREVIEW_COUNT, homeGalleryPage * GALLERY_PREVIEW_COUNT + GALLERY_PREVIEW_COUNT);

    document.getElementById("galleryGrid").innerHTML = pageItems.map((p) => `
      <div class="gallery-tile" data-id="${p.id}" style="${p.url ? `background-image:url('${p.url}');background-size:cover;background-position:center` : `background:linear-gradient(160deg, ${p.color}, #0B3D2E)`}">
        <span>${escapeHtml(p.caption)}</span>
      </div>`).join("");
    document.querySelectorAll("#galleryGrid .gallery-tile[data-id]").forEach((tile) => {
      tile.addEventListener("click", () => {
        const photo = state.gallery.find((p) => p.id === tile.dataset.id);
        openGalleryLightbox(photo);
      });
    });

    const pager = document.getElementById("galleryPagination");
    if (pager) {
      if (totalPages <= 1) { pager.innerHTML = ""; }
      else {
        pager.innerHTML = `
          ${homeGalleryPage > 0 ? `<button class="gal-page-btn" id="homeGalPrev">\u00ab Previous Page</button>` : ""}
          ${homeGalleryPage < totalPages - 1 ? `<button class="gal-page-btn" id="homeGalNext">View Next Page \u00bb</button>` : ""}`;
        const prevBtn = document.getElementById("homeGalPrev");
        const nextBtn = document.getElementById("homeGalNext");
        if (prevBtn) prevBtn.addEventListener("click", () => { homeGalleryPage--; renderGallery(); document.getElementById("galleryGrid").scrollIntoView({ behavior: "smooth", block: "nearest" }); });
        if (nextBtn) nextBtn.addEventListener("click", () => { homeGalleryPage++; renderGallery(); document.getElementById("galleryGrid").scrollIntoView({ behavior: "smooth", block: "nearest" }); });
      }
    }
  }

  // Full gallery overlay — shows every photo (not just the home-page preview),
  // reached via the "View All" tile so the home page never gets cluttered as
  // more event photos are added. Supports two densities: "small" (9/page, 3
  // columns) and "large" (6/page, 2 columns) with Next/page-number controls.
  let galleryDensity = "small"; // "small" | "large"
  let galleryPage = 0; // 0-indexed
  function galleryPageSize() { return galleryDensity === "large" ? 6 : 9; }

  function renderFullGalleryGrid() {
    const pageSize = galleryPageSize();
    const totalPages = Math.max(1, Math.ceil(state.gallery.length / pageSize));
    if (galleryPage >= totalPages) galleryPage = totalPages - 1;
    if (galleryPage < 0) galleryPage = 0;
    const pageItems = state.gallery.slice(galleryPage * pageSize, galleryPage * pageSize + pageSize);

    const grid = document.getElementById("fullGalleryGrid");
    grid.classList.toggle("large-density", galleryDensity === "large");
    grid.innerHTML = pageItems.map((p) => `
      <div class="gallery-tile" data-id="${p.id}" style="${p.url ? `background-image:url('${p.url}');background-size:cover;background-position:center` : `background:linear-gradient(160deg, ${p.color}, #0B3D2E)`}${galleryDensity === "large" ? ";min-height:11rem" : ""}">
        <span>${escapeHtml(p.caption)}</span>
      </div>`).join("");
    document.querySelectorAll("#fullGalleryGrid .gallery-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const photo = state.gallery.find((p) => p.id === tile.dataset.id);
        openGalleryLightbox(photo);
      });
    });

    // Page number buttons + Prev/Next
    const pager = document.getElementById("fullGalleryPagination");
    if (pager) {
      let html = `<button class="gallery-page-btn" id="galPrev" ${galleryPage === 0 ? "disabled" : ""}>&#8249;</button>`;
      for (let i = 0; i < totalPages; i++) {
        html += `<button class="gallery-page-btn ${i === galleryPage ? "active" : ""}" data-page="${i}">${i + 1}</button>`;
      }
      html += `<button class="gallery-page-btn" id="galNext" ${galleryPage >= totalPages - 1 ? "disabled" : ""}>&#8250;</button>`;
      pager.innerHTML = html;
      const prevBtn = document.getElementById("galPrev");
      const nextBtn = document.getElementById("galNext");
      if (prevBtn) prevBtn.addEventListener("click", () => { galleryPage--; renderFullGalleryGrid(); });
      if (nextBtn) nextBtn.addEventListener("click", () => { galleryPage++; renderFullGalleryGrid(); });
      pager.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
        galleryPage = parseInt(b.dataset.page, 10); renderFullGalleryGrid();
      }));
    }
  }

  function openFullGallery() {
    galleryPage = 0;
    document.getElementById("fullGalleryCount").textContent = `${state.gallery.length} photo${state.gallery.length === 1 ? "" : "s"}`;
    renderFullGalleryGrid();
    document.getElementById("fullGalleryOverlay").classList.remove("hidden");
    pushScreen(closeFullGallery);
  }
  const galSmallBtn = document.getElementById("galDensitySmall");
  const galLargeBtn = document.getElementById("galDensityLarge");
  if (galSmallBtn && galLargeBtn) {
    galSmallBtn.addEventListener("click", () => { galleryDensity = "small"; galleryPage = 0; galSmallBtn.classList.add("active"); galLargeBtn.classList.remove("active"); renderFullGalleryGrid(); });
    galLargeBtn.addEventListener("click", () => { galleryDensity = "large"; galleryPage = 0; galLargeBtn.classList.add("active"); galSmallBtn.classList.remove("active"); renderFullGalleryGrid(); });
  }
  function closeFullGallery() { document.getElementById("fullGalleryOverlay").classList.add("hidden"); }
  document.getElementById("btnCloseFullGallery").addEventListener("click", closeTopScreen);

  function openGalleryLightbox(photo) {
    modalBody.innerHTML = `
      <div class="gallery-preview" style="${photo.url ? `background-image:url('${photo.url}');background-size:cover;background-position:center` : `background:linear-gradient(160deg, ${photo.color}, #0B3D2E)`}">
        ${photo.url ? "" : `<div><div style="font-size:2.2rem;opacity:.7">\u{1F5BC}</div><div class="cap font-display">${escapeHtml(photo.caption)}</div></div>`}
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" id="btnDownloadPhoto">\u2B07 Download Photo</button>
        <button class="btn btn-whatsapp" id="btnSharePhoto">\u{1F4AC} Share</button>
      </div>
      <button class="modal-close" id="btnCloseGallery">Close</button>`;
    modalOverlay.classList.remove("hidden");
    pushScreen(closeModal);

    document.getElementById("btnDownloadPhoto").addEventListener("click", () => {
      if (!photo.url) {
        drawPoster({ rankLabel: "MEMORY", line1: photo.caption, line2: "", line3: "", subtitle: "Event Gallery" }).then((url) => {
          downloadDataUrl(url, `${photo.caption.replace(/\s+/g, "-")}.png`);
          showToast("Photo downloaded");
        });
        return;
      }
      showToast("Preparing photo\u2026");
      getFramedPhotoUrl(photo).then((finalUrl) => {
        downloadDataUrl(finalUrl, `${photo.caption.replace(/\s+/g, "-")}.jpg`);
        showToast("Photo downloaded");
      }).catch(() => showToast("Could not prepare that photo \u2014 check your connection"));
    });
    document.getElementById("btnSharePhoto").addEventListener("click", () => {
      const text = `\u{1F4F8}\u2728\n\n> ${state.hero.title}\n\n\u00a9 Event crew`;
      if (!photo.url) { window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank"); return; }
      showToast("Preparing photo\u2026");
      getFramedPhotoUrl(photo)
        .then((finalUrl) => shareImageWithText(finalUrl, `${photo.caption.replace(/\s+/g, "-")}.jpg`, text))
        .catch(() => showToast("Could not prepare that photo \u2014 check your connection"));
    });
    document.getElementById("btnCloseGallery").addEventListener("click", closeTopScreen);
  }

  /* ---------------- admin: login ---------------- */
  const SUPER_ADMIN_USER = "admin";
  const SUPER_ADMIN_PASS = "meelad786";
  const NORMAL_ADMIN_USER = "staff";
  const NORMAL_ADMIN_PASS = "meelad123";
  const SUPER_ONLY_TABS = ["poster", "limits"]; // home page design, categories/limits
  const loginScreen = document.getElementById("adminLoginScreen");
  const adminScreen = document.getElementById("adminScreen");
  const ADMIN_SESSION_KEY = "meelad_admin_session";
  const ADMIN_ROLE_KEY = "meelad_admin_role";
  const ADMIN_LAST_TAB_KEY = "meelad_admin_last_tab";
  function safeStorageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeStorageSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
  function safeStorageRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  let adminAuthed = safeStorageGet(ADMIN_SESSION_KEY) === "1";
  let adminRole = safeStorageGet(ADMIN_ROLE_KEY) || "super"; // "super" | "normal"
  let pendingAdminTab = "dashboard";
  function isSuperAdmin() { return adminRole === "super"; }

  function closeLoginScreen() { loginScreen.classList.add("hidden"); document.body.classList.remove("no-scroll"); }
  function closeAdminScreen() { adminScreen.classList.add("hidden"); document.body.classList.remove("no-scroll"); }

  function setActiveAdminTab(tab) {
    if (SUPER_ONLY_TABS.includes(tab) && !isSuperAdmin()) tab = "dashboard";
    // If a student profile's back-step is still pushed but the admin left
    // via a different tab instead of "Back to list", drop that stale entry
    // so it doesn't silently eat a future back-press.
    if (tab !== "students" && typeof profileScreenPushed !== "undefined" && profileScreenPushed) {
      const idx = screenStack.indexOf(studentProfileCloseFn);
      if (idx !== -1) screenStack.splice(idx, 1);
      profileScreenPushed = false;
      studentsView = { mode: "list", id: null };
    }
    safeStorageSet(ADMIN_LAST_TAB_KEY, tab); // so a reload lands back on this same tab instead of the home page
    document.querySelectorAll(".admin-menu-link").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".side-link[data-admin-tab]").forEach((l) => l.classList.toggle("active", l.dataset.adminTab === tab));
    renderAdminTab(tab);
  }

  let currentAdminTab = null; // which admin tab is currently showing, so tab switches can push a proper back-navigation step
  function openAdminEntry(tab) {
    closeSidebar(); // instant — we're about to swap this screen for the next one
    pendingAdminTab = tab || "dashboard";
    document.body.classList.add("no-scroll"); // bug fix: lock background scroll while dashboard/login is open
    if (adminAuthed) {
      adminScreen.classList.remove("hidden");
      swapTopScreen(closeAdminScreen);
      currentAdminTab = pendingAdminTab;
      setActiveAdminTab(pendingAdminTab);
      return;
    }
    document.getElementById("adminUser").value = "";
    document.getElementById("adminPass").value = "";
    document.getElementById("adminError").classList.add("hidden");
    loginScreen.classList.remove("hidden");
    swapTopScreen(closeLoginScreen);
  }

  document.querySelectorAll(".side-link[data-admin-tab]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openAdminEntry(link.dataset.adminTab);
    });
  });
  // Cancel always lands directly on the Home page (not back on the sidebar/
  // menu) — closing the login screen reveals Home underneath since nothing
  // else is stacked below it.
  document.getElementById("btnAdminCancel").addEventListener("click", closeTopScreen);
  document.getElementById("btnAdminLogin").addEventListener("click", () => {
    const u = document.getElementById("adminUser").value.trim();
    const p = document.getElementById("adminPass").value;
    const errEl = document.getElementById("adminError");
    let role = null;
    if (u === SUPER_ADMIN_USER && p === SUPER_ADMIN_PASS) role = "super";
    else if (u === NORMAL_ADMIN_USER && p === NORMAL_ADMIN_PASS) role = "normal";
    if (role) {
      adminAuthed = true;
      adminRole = role;
      safeStorageSet(ADMIN_SESSION_KEY, "1");
      safeStorageSet(ADMIN_ROLE_KEY, role);
      applyRoleVisibility();
      loginScreen.classList.add("hidden"); // instant — no-scroll stays locked since admin panel opens next
      adminScreen.classList.remove("hidden");
      swapTopScreen(closeAdminScreen);
      currentAdminTab = SUPER_ONLY_TABS.includes(pendingAdminTab) && role !== "super" ? "dashboard" : pendingAdminTab;
      setActiveAdminTab(currentAdminTab);
    } else {
      errEl.textContent = "Invalid username or password.";
      errEl.classList.remove("hidden");
    }
  });
  // Guest Mode (and Logout) always exit ALL the way back to the site home
  // page instantly — from either Super Admin or Admin, no matter what's
  // open. Bug fix: this used to call document.getElementById("loginScreen"),
  // an ID that doesn't exist (the real element is "adminLoginScreen") — that
  // threw an error and silently stopped the whole function before anything
  // actually closed, which is why Guest Mode did nothing.
  function goFullyHome() {
    adminScreen.classList.add("hidden");
    loginScreen.classList.add("hidden");
    unlockBodyScroll(); // bug fix: classList.remove("no-scroll") alone left the body's inline position:fixed/top styles (set by lockBodyScroll) in place, freezing the page until a manual refresh
    closeSidebar();
    closeAdminSidebar();
    modalOverlay.classList.add("hidden");
    document.getElementById("fullGalleryOverlay").classList.add("hidden");
    document.getElementById("printOverlay").classList.add("hidden");
    screenStack.length = 0;
    currentAdminTab = null;
    adminReturnPushed = false;
    if (typeof profileScreenPushed !== "undefined") profileScreenPushed = false;
    history.replaceState(null, "", location.pathname + location.search);
    window.scrollTo(0, 0);
  }
  document.getElementById("btnAdminGuestView").addEventListener("click", goFullyHome);

  // Hides Super-Admin-only items from the drawer/sidebar for Normal Admins,
  // and blocks direct navigation to those tabs.
  function applyRoleVisibility() {
    const superOnly = document.querySelectorAll('[data-super-only="1"]');
    superOnly.forEach((el) => { el.style.display = isSuperAdmin() ? "" : "none"; });
  }
  if (adminAuthed) applyRoleVisibility();
  // Reload while logged in used to always drop back to the public home
  // page, losing whatever admin tab was open. Session is already checked
  // above (adminAuthed) — if it's valid, re-enter the admin panel straight
  // to the last tab that was active instead of showing the starting page.
  // Deferred with setTimeout so it runs after the rest of this script
  // (further below, e.g. other const-bound elements/listeners) has finished
  // executing — calling it inline here broke the whole page load because it
  // reached into things not set up yet.
  if (adminAuthed) setTimeout(() => openAdminEntry(safeStorageGet(ADMIN_LAST_TAB_KEY) || "dashboard"), 0);

  /* ---------------- admin: portrait drawer menu ---------------- */
  const adminSidebar = document.getElementById("adminSidebar");
  const adminSidebarOverlay = document.getElementById("adminSidebarOverlay");
  function openAdminSidebar() { adminSidebar.classList.add("open"); adminSidebarOverlay.classList.remove("hidden"); pushScreen(closeAdminSidebar); }
  function closeAdminSidebar() { adminSidebar.classList.remove("open"); adminSidebarOverlay.classList.add("hidden"); }
  document.getElementById("btnAdminMenu").addEventListener("click", openAdminSidebar);
  document.getElementById("btnCloseAdminSidebar").addEventListener("click", closeTopScreen);
  adminSidebarOverlay.addEventListener("click", closeTopScreen);
  document.getElementById("btnDrawerLogout").addEventListener("click", (e) => {
    e.preventDefault();
    adminAuthed = false;
    adminRole = "super";
    safeStorageRemove(ADMIN_SESSION_KEY);
    safeStorageRemove(ADMIN_ROLE_KEY);
    goFullyHome();
    showToast("Logged out");
  });

  /* ---------------- admin: tabs ---------------- */
  const adminContent = document.getElementById("adminContent");
  let adminReturnPushed = false; // whether a "go back to Dashboard" step is already on the stack
  document.querySelectorAll(".admin-menu-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const newTab = link.dataset.tab;
      closeTopScreen(); // close drawer instantly
      // Back should always land on the Admin Dashboard (main menu) in one
      // press, no matter how many tabs were visited in between \u2014 not walk
      // backward through each tab one at a time. So only one "return to
      // Dashboard" step is ever on the stack at once: it's pushed the first
      // time the admin leaves Dashboard, and cleared once they're back on it
      // (whether via Back or by tapping Dashboard directly) so it can be
      // pushed fresh next time they leave again.
      if (newTab === "dashboard") {
        adminReturnPushed = false;
      } else if (!adminReturnPushed) {
        adminReturnPushed = true;
        pushScreen(() => { adminReturnPushed = false; currentAdminTab = "dashboard"; setActiveAdminTab("dashboard"); });
      }
      currentAdminTab = newTab;
      setActiveAdminTab(newTab);
    });
  });

  function renderAdminTab(tab) {
    if (tab === "dashboard") return renderDashboardTab();
    if (tab === "poster") return renderPosterTab();
    if (tab === "chestnumber") return renderChestNumberTab();
    if (tab === "teams") return renderTeamsTab();
    if (tab === "events") return renderEventsTab();
    if (tab === "competitions") return renderCompetitionsTab();
    if (tab === "markentry") return renderMarksTab();
    if (tab === "topscore") return renderTopScoreTab();
    if (tab === "limits") return renderLimitsTab();
    if (tab === "students") return renderStudentsTab();
    if (tab === "gallery") return renderGalleryTab();
    if (tab === "export") return renderExportTab();
    if (tab === "results") return renderResultsTab();
    if (tab === "schedule") return renderScheduleTab();
  }

  /* ---- Dashboard tab ---- */
  /* ---------------- sample/test data (Red / Blue / Green batch) ----------------
     Loads a full demo dataset for testing (12 programmes, 3 teams, 50 students).
     Every id it creates is recorded in state.testDataBatch, so "Delete Test Data"
     removes exactly what this loaded and nothing else \u2014 any real data the admin
     has entered separately is never touched. */
  const TEST_TEAMS = [
    { name: "Team Red", color: "#FCA5A5" },
    { name: "Team Blue", color: "#93C5FD" },
    { name: "Team Green", color: "#86EFAC" },
  ];
  // Each category's programme list: [name, type, groupLimit(only for Group)]
  const TEST_CATEGORY_EVENTS = {
    "Sub Junior": [["Group Song", "Group", 3], ["Elocution", "Individual"], ["Pencil Drawing", "Individual"]],
    "Junior": [["Quiz", "Group", 3], ["Group Dance", "Group", 3], ["Recitation", "Individual"]],
    "Senior": [["Drama/Skit", "Group", 3], ["Monoact", "Individual"], ["Essay Writing", "Individual"]],
    "Super Senior": [["Group Music", "Group", 3], ["Anchor/Host", "Individual"], ["Poster Making", "Individual"]],
  };
  // [name, [event index list within that category's programme array], gender]
  const TEST_STUDENTS = {
    "Team Red": {
      "Sub Junior": [["Muhammed Shan", [0, 1], "Boys"], ["Fatima Hiba", [0, 2], "Girls"], ["Ayan Ali", [0], "Boys"], ["Raihana K.", [1, 2], "Girls"]],
      "Junior": [["Bilal Hassan", [0, 2], "Boys"], ["Nuha Fatima", [1], "Girls"], ["Rayan Khalid", [1, 0], "Boys"], ["Shaza Mehreen", [1, 0], "Girls"]],
      "Senior": [["Adil Farhan", [0, 2], "Boys"], ["Afeefa K.", [0, 1], "Girls"], ["Nihan Ziyad", [0], "Boys"], ["Saniya Zehra", [1, 2], "Girls"]],
      "Super Senior": [["Arfan Ahmed", [0, 2], "Boys"], ["Lubna Fathima", [0, 1], "Girls"], ["Sahal Tariq", [0], "Boys"], ["Shifa Naaz", [1, 2], "Girls"]],
    },
    "Team Blue": {
      "Sub Junior": [["Muhammed Afeef", [0, 1], "Boys"], ["Ayisha Rinsha", [0, 2], "Girls"], ["Zayan Ahmed", [0], "Boys"], ["Haniya Maryam", [1, 2], "Girls"]],
      "Junior": [["Hamdan Amir", [0, 2], "Boys"], ["Liya Fathima", [1], "Girls"], ["Irfan Rasheed", [1, 0], "Boys"], ["Zara Sulthana", [1, 0], "Girls"]],
      "Senior": [["Fahad Mustafa", [0, 1], "Boys"], ["Minha Fathima", [0, 2], "Girls"], ["Hashir Zaman", [0], "Boys"], ["Rifa Nafeesa", [2, 1], "Girls"]],
      "Super Senior": [["Zayd Hussain", [0, 1], "Boys"], ["Aleena Shirin", [0, 2], "Girls"], ["Danish Ali", [0], "Boys"], ["Hibah Noor", [1, 2], "Girls"]],
    },
    "Team Green": {
      "Sub Junior": [["Danish Rizwan", [0, 2], "Boys"], ["Fidha Fatima", [0, 1], "Girls"], ["Izhaan Malik", [0], "Boys"], ["Sana Parveen", [1, 2], "Girls"]],
      "Junior": [["Salman Tariq", [0, 2], "Boys"], ["Mehreen K.", [1], "Girls"], ["Adnan Sami", [1, 0], "Boys"], ["Rushda K.", [1, 0, 2], "Girls"]],
      "Senior": [["Yaseen Malik", [0], "Boys"], ["Thasniya S.", [0, 2], "Girls"], ["Wasim Akram", [0, 1], "Boys"], ["Ilham Zayan", [1], "Boys"], ["Ayisha Hanna", [2], "Girls"]],
      "Super Senior": [["Rehan Sadiq", [0, 2], "Boys"], ["Sumayya K.", [0, 1], "Girls"], ["Tariq Aziz", [0], "Boys"], ["Wafa Kulsum", [1], "Girls"], ["Zaid Ahmed", [2], "Boys"]],
    },
  };

  function isTestDataLoaded() { return !!(state.testDataBatch && state.testDataBatch.active); }

  function loadTestData() {
    if (isTestDataLoaded()) return showToast("Test data is already loaded \u2014 delete it first to reload");
    const batch = { active: true, teamIds: [], eventIds: [], studentIds: [] };

    // Categories (Sub Junior/Junior/Senior/Super Senior) already exist by
    // default, so they're left untouched \u2014 only events/teams/students below
    // are newly created and tracked for later deletion.
    const eventIdByCatName = {};
    Object.keys(TEST_CATEGORY_EVENTS).forEach((cat) => {
      if (!state.categories.includes(cat)) state.categories.push(cat); // safety net only
      eventIdByCatName[cat] = {};
      TEST_CATEGORY_EVENTS[cat].forEach(([evName, evType, groupLimit]) => {
        const id = uid();
        state.events.push({
          id, name: evName, category: cat, type: evType || "Individual", gender: "General",
          status: "pending", resultStatus: "Pending", assignedJudges: [...state.judges],
          ...(evType === "Group" ? { groupLimit: groupLimit || 3 } : {}),
        });
        eventIdByCatName[cat][evName] = id;
        batch.eventIds.push(id);
      });
    });

    const teamIdByName = {};
    TEST_TEAMS.forEach((t) => {
      const id = uid();
      state.teams.push({ id, name: t.name, color: t.color, leader: "", assistant: "" });
      teamIdByName[t.name] = id;
      batch.teamIds.push(id);
    });

    Object.keys(TEST_STUDENTS).forEach((teamName) => {
      const teamId = teamIdByName[teamName];
      const byCategory = TEST_STUDENTS[teamName];
      Object.keys(byCategory).forEach((cat) => {
        const evNames = TEST_CATEGORY_EVENTS[cat].map(([n]) => n);
        byCategory[cat].forEach(([name, evIdxList, gender]) => {
          const chestNo = nextChestNo(cat);
          const id = uid();
          const events = evIdxList.map((i) => eventIdByCatName[cat][evNames[i]]);
          state.students.push({ id, name, cls: "", phone: "", gender: gender || "Boys", team: teamId, category: cat, chestNo, events });
          batch.studentIds.push(id);
        });
      });
    });

    state.testDataBatch = batch;
    persist();
    renderCounters(); renderLeaderboard(); renderTicker(); renderFilters(); renderResultsList();
    showToast("Test data loaded \u2014 12 programmes, 3 teams, 50 students");
    renderDashboardTab();
  }

  function deleteTestData() {
    if (!isTestDataLoaded()) return showToast("No test data is currently loaded");
    const batch = state.testDataBatch;
    state.students = state.students.filter((s) => !batch.studentIds.includes(s.id));
    state.events = state.events.filter((e) => !batch.eventIds.includes(e.id));
    state.teams = state.teams.filter((t) => !batch.teamIds.includes(t.id));
    state.testDataBatch = { active: false, teamIds: [], eventIds: [], studentIds: [] };
    persist();
    renderCounters(); renderLeaderboard(); renderTicker(); renderFilters(); renderResultsList(); renderChecklist();
    showToast("Test data deleted \u2014 back to your real data");
    renderDashboardTab();
  }

  function renderDashboardTab() {
    const marksEntered = Object.values(state.marks).reduce((sum, ev) => sum + Object.keys(ev).length, 0);
    const resultsPublished = state.events.filter((e) => e.resultStatus === "Published").length;
    const cards = [
      { label: "Teams", value: state.teams.length, ic: "&#128101;", cls: "ic-green" },
      { label: "Categories", value: state.categories.length, ic: "&#128220;", cls: "ic-blue" },
      { label: "Events", value: state.events.length, ic: "&#127941;", cls: "ic-orange" },
      { label: "Students", value: state.students.length, ic: "&#128100;", cls: "ic-purple" },
      { label: "Marks Entered", value: marksEntered, ic: "&#127908;", cls: "ic-pink" },
      { label: "Results Published", value: resultsPublished, ic: "&#127942;", cls: "ic-red" },
    ];
    adminContent.innerHTML = `
      <div class="dash-grid">
        ${cards.map((c) => `
          <div class="dash-card">
            <div class="atab-ic ${c.cls}" style="width:2.4rem;height:2.4rem;font-size:1.1rem;border-radius:.7rem;margin-bottom:.9rem">${c.ic}</div>
            <div class="dash-value">${c.value}</div>
            <div class="dash-label">${c.label}</div>
          </div>`).join("")}
      </div>
      ${isSuperAdmin() ? `
      <div class="card" style="margin-top:1.25rem">
        <div class="card-title">Test Data</div>
        <div class="field-label" style="margin-bottom:.6rem">Loads a demo dataset for trying things out \u2014 12 programmes, 3 teams (Red/Blue/Green), 50 students. Fully reversible: Delete removes exactly what Load added, nothing else.</div>
        ${isTestDataLoaded()
          ? `<div class="muted" style="font-size:.75rem;margin-bottom:.6rem">\u2705 Test data is currently loaded.</div>
             <button class="btn btn-ghost" id="btnDeleteTestData" style="width:auto;padding:.5rem .9rem">Delete Test Data</button>`
          : `<button class="btn btn-primary" id="btnLoadTestData" style="width:auto;padding:.5rem .9rem">\u2B07 Load Test Data</button>`}
      </div>
      <div class="card" style="margin-top:1.25rem">
        <div class="card-title">Clean Up Orphaned Data</div>
        <div class="field-label" style="margin-bottom:.6rem">Marks or results left behind by a programme/student that was deleted earlier (before this cleanup existed) can make counts like "Marks Entered" look wrong. This scans for and removes anything pointing to a programme or student that no longer exists \u2014 doesn't touch anything still in use.</div>
        <button class="btn btn-ghost" id="btnCleanOrphans" style="width:auto;padding:.5rem .9rem">\u{1F9F9} Scan &amp; Clean Up</button>
      </div>` : ""}`;
    const btnLoadTD = document.getElementById("btnLoadTestData");
    if (btnLoadTD) btnLoadTD.addEventListener("click", loadTestData);
    const btnDelTD = document.getElementById("btnDeleteTestData");
    if (btnDelTD) btnDelTD.addEventListener("click", () => {
      if (confirm("Delete all test data (3 teams, 50 students, 12 programmes)? This can't be undone.")) deleteTestData();
    });
    const btnCleanOrphans = document.getElementById("btnCleanOrphans");
    if (btnCleanOrphans) btnCleanOrphans.addEventListener("click", () => {
      const removed = cleanOrphanedData();
      persist(); renderCounters(); renderDashboardTab();
      showToast(removed ? `Cleaned up ${removed} orphaned mark${removed === 1 ? "" : "s"}` : "No orphaned data found \u2014 everything's clean");
    });
  }

  /* ---- Poster tab ---- */
  // Templates are the madrasa's own designed posters (uploaded as images),
  // not built-in presets — each template carries its imageUrl, textY (where
  // the winner's name sits, as % from top) and textColor.
  function getAllTemplates() {
    return state.customTemplates.map((t) => ({
      id: t.id, label: t.label, imageUrl: t.imageUrl,
      textY: t.textY, textColor: t.textColor,
      bg: t.imageUrl ? `url('${t.imageUrl}') center/cover` : "#0B3D2E",
      fg: "#fff", custom: true,
    }));
  }
  function renderPosterTab() {
    const h = state.hero;
    const allTemplates = getAllTemplates();
    const resultTemplates = getAllResultTemplates();
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Page Header</div>
        <div class="field-label">Shown at the top of every page (menu bar), independent of the poster below.</div>
        <input id="fHeaderText" class="input" style="margin:.4rem 0 .75rem" value="${escapeAttr(h.headerText || h.title)}" />
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer">
          <input type="checkbox" id="fShowHeaderText" ${h.showHeaderText === false ? "" : "checked"} />
          <span class="field-label" style="margin:0">Show this Page Header text (turn off to hide it completely from the top bar)</span>
        </label>
        <button class="btn btn-primary" id="btnSaveHeader" style="width:auto;padding:.5rem .9rem">\u2713 Save Header</button>
      </div>

      <div class="card">
        <div class="card-title">Header Bar Background Photo</div>
        <div class="field-label">Optional small background photo behind the top menu bar (the header text stays readable over it automatically).</div>
        ${h.headerPhotoUrl ? `<div class="hero-photo-preview" style="background-image:url('${h.headerPhotoUrl}');height:4.5rem"></div>` : ""}
        <input type="file" id="headerPhotoFile" accept="image/*" class="input" style="margin:.5rem 0;padding:.4rem" />
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-primary" id="btnSaveHeaderPhoto" style="width:auto;padding:.5rem .9rem">${h.headerPhotoUrl ? "Replace Photo" : "Upload Photo"}</button>
          ${h.headerPhotoUrl ? `<button class="btn btn-ghost" id="btnRemoveHeaderPhoto" style="width:auto;padding:.5rem .9rem">Remove</button>` : ""}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Home Page Poster</div>
        <div class="field-label">Upload your own designed poster (from Canva, Photoshop, etc.) \u2014 it replaces the whole banner at the top of the home page, exactly as you made it. No poster uploaded yet? A simple text banner is shown instead.</div>
        ${h.photoUrl ? `<div class="hero-photo-preview" style="background-image:url('${h.photoUrl}')"></div>` : ""}
        <input type="file" id="heroPhotoFile" accept="image/*" class="input" style="margin:.5rem 0;padding:.4rem" />
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-primary" id="btnSaveHeroPhoto" style="width:auto;padding:.5rem .9rem">${h.photoUrl ? "Replace Photo" : "Upload Photo"}</button>
          ${h.photoUrl ? `<button class="btn btn-ghost" id="btnRemoveHeroPhoto" style="width:auto;padding:.5rem .9rem">Remove</button>` : ""}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Poster Templates</div>
        <div class="field-label" style="margin-bottom:.5rem">Upload up to 5 of your own designed poster templates (Canva, Photoshop, etc.) \u2014 with your madrasa's name, logo and branding already on them. <b>Recommended size: 1080\u00d71350px (portrait).</b> Leave the bottom \u2248\u2153 of the image clear \u2014 that's where the winner's rank, name, chest number and team are printed automatically when a parent downloads it. Parents swipe through your templates and pick one.</div>
        <div class="template-row" id="templateRow">
          ${allTemplates.map((t) => `
            <div class="template-swatch ${h.posterTemplate === t.id ? "selected" : ""}" data-tpl="${t.id}" style="background:${t.bg};color:${t.fg};text-shadow:0 1px 3px rgba(0,0,0,.6);position:relative">
              ${t.label}
              ${t.custom ? `<span class="template-del" data-id="${t.id}">&times;</span>` : ""}
            </div>`).join("")}
        </div>
        <button class="link-btn" id="btnShowAddTemplate" style="text-align:left;color:var(--gold-light);padding:0;margin-bottom:.5rem">+ Add Template ${state.customTemplates.length}/5</button>
        <div id="addTemplateForm"></div>
      </div>

      <div class="card">
        <div class="card-title">Result Templates (1st, 2nd &amp; 3rd together)</div>
        <div class="field-label" style="margin-bottom:.5rem">Upload up to 5 result-frame designs \u2014 used on the "Result Download Options" page when someone taps the search icon to see all three winners of a programme in one poster. <b>Recommended size: 1080\u00d71350px (portrait).</b> Text is placed automatically \u2014 just upload a background.</div>
        <div class="template-row" id="resultTemplateRow">
          ${resultTemplates.map((t) => `
            <div class="template-swatch result-template-swatch ${h.resultTemplate === t.id ? "selected" : ""}" data-tpl="${t.id}" style="background:${t.imageUrl ? `url('${t.imageUrl}') center/cover` : "#0B3D2E"};color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);position:relative">
              <span class="template-del result-template-del" data-id="${t.id}">&times;</span>
            </div>`).join("")}
        </div>
        <button class="link-btn" id="btnShowAddResultTemplate" style="text-align:left;color:var(--gold-light);padding:0;margin-bottom:.5rem">+ Add Result Template ${state.resultTemplates.length}/5</button>
        <div id="addResultTemplateForm"></div>
      </div>

      <div class="card">
        <div class="card-title">Homepage Poster Text</div>
        <div class="field-label">Heading (also used as a fallback banner, and in WhatsApp share text)</div>
        <input id="fTitle" class="input" style="margin-bottom:.5rem" value="${escapeAttr(h.title)}" />
        <div class="field-label">Subtitle (paragraph shown under the heading on the home banner)</div>
        <input id="fSubtitle" class="input" style="margin-bottom:.75rem" value="${escapeAttr(h.subtitle)}" />
        <div class="field-label">Text Colour (heading &amp; subtitle on the home banner)</div>
        <input id="fTextColor" type="color" class="input" value="${escapeAttr(h.textColor || "#FFFFFF")}" style="margin-bottom:.75rem;padding:.25rem;width:4rem" />
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer">
          <input type="checkbox" id="fShowText" ${h.showText === false ? "" : "checked"} />
          <span class="field-label" style="margin:0">Show badge, heading &amp; subtitle text on the home banner (turn off if your poster photo already has this text on it \u2014 the Page Header above is not affected)</span>
        </label>
        <button class="btn btn-primary" id="btnSavePoster" style="width:auto;padding:.6rem 1rem">\u2713 Save Poster Text</button>
      </div>
      <div class="muted" style="font-size:.72rem">Preview updates live on the Home page as soon as you save.</div>`;

    document.getElementById("btnSaveHeader").addEventListener("click", () => {
      try {
        state.hero.headerText = document.getElementById("fHeaderText").value || state.hero.title;
        state.hero.showHeaderText = document.getElementById("fShowHeaderText").checked;
        persist(); renderHero();
        showToast("Page header saved");
      } catch (err) {
        console.error("Save Header failed:", err);
        showToast("Save Header failed: " + (err.message || err).toString().slice(0, 100));
      }
    });

    document.getElementById("btnSaveHeroPhoto").addEventListener("click", () => {
      const file = document.getElementById("heroPhotoFile").files[0];
      if (!file) return showToast("Choose a photo first");
      showToast("Uploading\u2026");
      compressImageFile(file, 1400, 0.75).then((dataUrl) => {
        state.hero.photoUrl = dataUrl;
        persist(); renderHero(); renderPosterTab();
        showToast("Home page photo updated");
      }).catch(() => showToast("Could not process that photo"));
    });
    const removeBtn = document.getElementById("btnRemoveHeroPhoto");
    if (removeBtn) removeBtn.addEventListener("click", () => {
      delete state.hero.photoUrl;
      persist(); renderHero(); renderPosterTab();
      showToast("Home page photo removed");
    });

    document.getElementById("btnSaveHeaderPhoto").addEventListener("click", () => {
      const file = document.getElementById("headerPhotoFile").files[0];
      if (!file) return showToast("Choose a photo first");
      showToast("Uploading\u2026");
      compressImageFile(file, 900, 0.7).then((dataUrl) => {
        state.hero.headerPhotoUrl = dataUrl;
        persist(); renderHero(); renderPosterTab();
        showToast("Header background photo updated");
      }).catch(() => showToast("Could not process that photo"));
    });
    const removeHeaderPhotoBtn = document.getElementById("btnRemoveHeaderPhoto");
    if (removeHeaderPhotoBtn) removeHeaderPhotoBtn.addEventListener("click", () => {
      delete state.hero.headerPhotoUrl;
      persist(); renderHero(); renderPosterTab();
      showToast("Header background photo removed");
    });

    document.querySelectorAll("#templateRow .template-swatch").forEach((sw) => {
      sw.addEventListener("click", () => {
        document.querySelectorAll("#templateRow .template-swatch").forEach((s) => s.classList.remove("selected"));
        sw.classList.add("selected");
      });
    });
    document.getElementById("btnShowAddTemplate").addEventListener("click", () => {
      if (state.customTemplates.length >= 5) return showToast("Maximum 5 custom templates \u2014 delete one first");
      const holder = document.getElementById("addTemplateForm");
      if (holder.innerHTML) { holder.innerHTML = ""; return; }
      holder.innerHTML = `
        <div class="card" style="margin-bottom:.75rem">
          <div class="field-label">Template Name</div>
          <input id="ntName" class="input" placeholder="e.g. Gold Frame" style="margin-bottom:.5rem" />
          <div class="field-label">Poster Image \u2014 portrait, 1080\u00d71350px recommended</div>
          <input type="file" id="ntImage" accept="image/*" class="input" style="margin-bottom:.5rem;padding:.4rem" />
          <div class="grid3" style="margin-bottom:.5rem">
            <div><div class="field-label">Name Text Colour</div><input id="ntFg" type="color" class="input" value="#FFFFFF" style="padding:.25rem" /></div>
          </div>
          <div class="field-label">Text Position (how far down the image the rank/name/team text starts)</div>
          <input id="ntTextY" type="range" min="30" max="90" value="78" style="width:100%;margin-bottom:.75rem" />
          <button class="btn btn-primary" id="btnSaveTemplate" style="width:auto;padding:.5rem .9rem">Save Template</button>
        </div>`;
      document.getElementById("btnSaveTemplate").addEventListener("click", () => {
        const name = document.getElementById("ntName").value.trim() || "Custom";
        const file = document.getElementById("ntImage").files[0];
        const textY = Number(document.getElementById("ntTextY").value);
        const textColor = document.getElementById("ntFg").value;
        if (!file) return showToast("Choose a poster image first");
        showToast("Compressing template image\u2026");
        compressImageFile(file, 1350, 0.82).then((imageUrl) => {
          state.customTemplates.push({ id: "custom-" + uid(), label: name, imageUrl, textY, textColor });
          persist(); showToast("Template added"); renderPosterTab();
        }).catch(() => showToast("Could not process that image"));
      });
    });
    document.querySelectorAll("#templateRow .template-del").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.customTemplates = state.customTemplates.filter((t) => t.id !== b.dataset.id);
      persist(); renderPosterTab();
    }));

    document.querySelectorAll("#resultTemplateRow .result-template-swatch").forEach((sw) => {
      sw.addEventListener("click", () => {
        document.querySelectorAll("#resultTemplateRow .result-template-swatch").forEach((s) => s.classList.remove("selected"));
        sw.classList.add("selected");
      });
    });
    document.getElementById("btnShowAddResultTemplate").addEventListener("click", () => {
      if (state.resultTemplates.length >= 5) return showToast("Maximum 5 result templates \u2014 delete one first");
      const holder = document.getElementById("addResultTemplateForm");
      if (holder.innerHTML) { holder.innerHTML = ""; return; }
      holder.innerHTML = `
        <div class="card" style="margin-bottom:.75rem">
          <div class="field-label">Result Frame Image \u2014 portrait, 1080\u00d71350px recommended</div>
          <input type="file" id="rtImage" accept="image/*" class="input" style="margin-bottom:.5rem;padding:.4rem" />
          <div class="muted" style="font-size:.68rem;margin-bottom:.75rem">Text position is fixed automatically \u2014 just upload a background image.</div>
          <button class="btn btn-primary" id="btnSaveResultTemplate" style="width:auto;padding:.5rem .9rem">Save Template</button>
        </div>`;
      document.getElementById("btnSaveResultTemplate").addEventListener("click", () => {
        const file = document.getElementById("rtImage").files[0];
        if (!file) return showToast("Choose a result frame image first");
        showToast("Compressing template image\u2026");
        compressImageFile(file, 1080, 0.82).then((imageUrl) => {
          const newTpl = { id: "result-" + uid(), imageUrl };
          state.resultTemplates.push(newTpl);
          // Auto-activate the newly uploaded template so it's used right
          // away — otherwise the admin also has to tap the swatch and press
          // "Save" separately, and the poster silently keeps showing the
          // plain fallback background until they do.
          state.hero.resultTemplate = newTpl.id;
          persist(); showToast("Result template added"); renderPosterTab();
        }).catch(() => showToast("Could not process that image"));
      });
    });
    document.querySelectorAll("#resultTemplateRow .result-template-del").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.resultTemplates = state.resultTemplates.filter((t) => t.id !== b.dataset.id);
      persist(); renderPosterTab();
    }));

    document.getElementById("btnSavePoster").addEventListener("click", () => {
      try {
        const selectedTpl = document.querySelector("#templateRow .template-swatch.selected");
        const selectedResultTpl = document.querySelector("#resultTemplateRow .result-template-swatch.selected");
        state.hero = {
          ...h,
          title: document.getElementById("fTitle").value,
          subtitle: document.getElementById("fSubtitle").value,
          textColor: document.getElementById("fTextColor").value,
          showText: document.getElementById("fShowText").checked,
          posterTemplate: selectedTpl ? selectedTpl.dataset.tpl : h.posterTemplate,
          resultTemplate: selectedResultTpl ? selectedResultTpl.dataset.tpl : h.resultTemplate,
        };
        persist();
        renderHero();
        showToast("Home page updated");
      } catch (err) {
        console.error("Save Poster Text failed:", err);
        showToast("Save Poster Text failed: " + (err.message || err).toString().slice(0, 100));
      }
    });
  }

  /* ---- Chest Number tab (merged: categories/start numbers, master
     template + tag placement editor [super admin], and category-based
     card generation with bulk actions [all admins]) ---- */
  function renderChestNumberTab() {
    const super_ = isSuperAdmin();
    const mt = state.masterCardTemplate || { imageUrl: null, placements: [] };

    adminContent.innerHTML = `
      ${super_ ? `
      <div class="card">
        <div class="card-title">Categories &amp; Start Numbers</div>
        <div class="field-label" style="margin-bottom:.6rem">Numbers fill the lowest free slot in each category, starting from its Start Number. Deleting a student frees their number \u2014 the next student added gets it back (numbers are reused, never skipped).</div>
        <div class="marks-table-wrap">
          <table class="marks-table">
            <thead><tr><th>Category Name</th><th>Active</th><th>Start Number</th><th></th><th></th></tr></thead>
            <tbody>
              ${state.categories.map((c) => {
                const active = state.students.filter((s) => s.category === c).length;
                const start = state.categoryStartNumbers[c] || 1;
                const safeId = c.replace(/[^a-zA-Z0-9]/g, "_");
                return `<tr>
                  <td style="text-align:left">${escapeHtml(c)}</td>
                  <td>${active}</td>
                  <td><input type="number" step="1" class="input chest-start-input" data-category="${escapeAttr(c)}" id="start_${safeId}" value="${start}" style="width:5.5rem;padding:.35rem .5rem;font-family:'JetBrains Mono',monospace" /></td>
                  <td><button class="btn btn-primary btn-save-start" data-category="${escapeAttr(c)}" style="width:auto;padding:.35rem .6rem;font-size:.7rem">Save</button></td>
                  <td><button class="btn btn-ghost btn-delete-category" data-category="${escapeAttr(c)}" style="width:auto;padding:.35rem .6rem;font-size:.68rem;border-color:var(--crimson);color:var(--crimson)">Delete</button></td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">+ Add Category</div>
        <div class="field-label" style="margin-bottom:.5rem">A new category automatically starts at the next free hundred above every existing category's start number.</div>
        <div style="display:flex;gap:.5rem;align-items:center">
          <input id="newCategoryName" class="input" placeholder="e.g. Kids" style="flex:1" />
          <button class="btn btn-primary" id="btnAddCategory" style="width:auto;padding:.5rem .9rem">+ Add</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Master Card Template</div>
        <div class="field-label" style="margin-bottom:.5rem">Upload <b>one</b> template design (landscape, recommended 1013\u00d7638px). Name, Chest No, Category and Team are placed on it automatically.</div>
        ${mt.imageUrl ? `<button class="btn btn-ghost" id="btnReplaceTemplate" style="width:auto;padding:.4rem .8rem;margin-bottom:.6rem;font-size:.72rem">Replace Image</button>` : ""}
        <input type="file" id="mtImageInput" accept="image/*" class="input" style="margin-bottom:.75rem;padding:.4rem;${mt.imageUrl ? "display:none" : ""}" />
        ${mt.imageUrl ? `<img src="${mt.imageUrl}" style="width:100%;border-radius:.6rem;display:block" />` : ""}
      </div>

      <div class="card">
        <div class="card-title" style="color:var(--crimson)">Reset Sample Data</div>
        <div class="field-label" style="margin-bottom:.5rem">Removes <b>every registered student</b> and their chest numbers so real registrations can start fresh from each category's Start Number. Teams, programmes and categories themselves are kept. This cannot be undone.</div>
        <button class="btn btn-ghost" id="btnResetStudents" style="width:auto;padding:.5rem .9rem;border-color:var(--crimson);color:var(--crimson)">Delete All Students &amp; Reset Numbers</button>
      </div>` : ""}

      <div class="card">
        <div class="card-title">Generate Chest Number Cards</div>
        ${mt.imageUrl ? "" : `<div class="empty-note" style="margin-bottom:.75rem">${super_ ? "Upload a master template above to start generating cards." : "No master template has been uploaded yet \u2014 ask your super admin to add one."}</div>`}

        <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
          <label class="radio-pill"><input type="radio" name="cnMode" value="all" checked /> All Students</label>
          <label class="radio-pill"><input type="radio" name="cnMode" value="one" /> Student</label>
        </div>

        <div id="cnAllPanel">
          <div class="field-label" style="margin-bottom:.4rem">Category</div>
          <select id="cnCategoryPick" class="input" style="margin-bottom:.75rem">
            ${state.categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)} (${state.students.filter((s) => s.category === c).length} students)</option>`).join("")}
          </select>
          <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
            <label class="radio-pill"><input type="radio" name="cnPerPage" value="8" checked /> 8 per page</label>
            <label class="radio-pill"><input type="radio" name="cnPerPage" value="12" /> 12 per page</label>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem">
            <button class="btn btn-primary" id="btnBulkPrint" style="width:auto;padding:.5rem .9rem">\u{1F5A8} Bulk Print</button>
            <button class="btn btn-primary" id="btnBulkDownload" style="width:auto;padding:.5rem .9rem">\u2B07 Download PDF</button>
            <button class="btn btn-whatsapp" id="btnBulkShare" style="width:auto;padding:.5rem .9rem">\u{1F4AC} Bulk Share</button>
          </div>
        </div>

        <div id="cnOnePanel" style="display:none">
          <div class="field-label" style="margin-bottom:.4rem">Student (name \u2014 chest no)</div>
          <select id="cnStudentPick" class="input" style="margin-bottom:.75rem">
            ${state.students.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} \u2014 ${s.chestNo} (${escapeHtml(s.category)})</option>`).join("")}
          </select>
          <div style="display:flex;flex-wrap:wrap;gap:.5rem">
            <button class="btn btn-primary" id="btnOnePrint" style="width:auto;padding:.5rem .9rem">\u{1F5A8} Print</button>
            <button class="btn btn-primary" id="btnOneDownload" style="width:auto;padding:.5rem .9rem">\u2B07 Download</button>
            <button class="btn btn-whatsapp" id="btnOneShare" style="width:auto;padding:.5rem .9rem">\u{1F4AC} Share</button>
          </div>
        </div>
      </div>`;

    document.querySelectorAll('input[name="cnMode"]').forEach((r) => r.addEventListener("change", () => {
      const isAll = document.querySelector('input[name="cnMode"]:checked').value === "all";
      document.getElementById("cnAllPanel").style.display = isAll ? "" : "none";
      document.getElementById("cnOnePanel").style.display = isAll ? "none" : "";
    }));

    document.getElementById("btnBulkPrint").addEventListener("click", () => {
      const perPage = Number(document.querySelector('input[name="cnPerPage"]:checked').value);
      openBulkCardPrintSheet(document.getElementById("cnCategoryPick").value, perPage);
    });
    document.getElementById("btnBulkDownload").addEventListener("click", () => {
      const category = document.getElementById("cnCategoryPick").value;
      const perPage = Number(document.querySelector('input[name="cnPerPage"]:checked').value);
      generateMasterCardsPdf(category, perPage).then((res) => {
        if (!res) return;
        const url = URL.createObjectURL(res.blob);
        downloadDataUrl(url, res.filename);
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }).catch(() => {});
    });
    document.getElementById("btnBulkShare").addEventListener("click", () => {
      const category = document.getElementById("cnCategoryPick").value;
      const perPage = Number(document.querySelector('input[name="cnPerPage"]:checked').value);
      generateMasterCardsPdf(category, perPage).then((res) => {
        if (!res) return;
        shareBlobFile(res.blob, res.filename, "application/pdf", `${category} chest number cards \u2014 ${state.hero.title}`);
      }).catch(() => {});
    });

    document.getElementById("btnOnePrint").addEventListener("click", () => {
      const student = state.students.find((s) => s.id === document.getElementById("cnStudentPick").value);
      if (!student) return;
      if (!mt.imageUrl) return showToast("Upload a master template first");
      showToast("Preparing card for print\u2026");
      drawMasterCard(student).then((url) => {
        document.getElementById("printTitle").textContent = "Chest Number Card";
        document.getElementById("printContent").innerHTML = `<div class="bulk-card-print-grid"><img src="${url}" class="bulk-card-print-img" /></div>`;
        document.getElementById("printOverlay").classList.remove("hidden");
        pushScreen(() => document.getElementById("printOverlay").classList.add("hidden"));
      }).catch(() => showToast("Could not generate card"));
    });
    document.getElementById("btnOneDownload").addEventListener("click", () => {
      const student = state.students.find((s) => s.id === document.getElementById("cnStudentPick").value);
      if (!student) return;
      if (!mt.imageUrl) return showToast("Upload a master template first");
      showToast("Preparing card\u2026");
      drawMasterCard(student).then((url) => { downloadDataUrl(url, `${student.chestNo}-chest-no-card.jpg`); showToast("Card downloaded"); })
        .catch(() => showToast("Could not generate card"));
    });
    document.getElementById("btnOneShare").addEventListener("click", () => {
      const student = state.students.find((s) => s.id === document.getElementById("cnStudentPick").value);
      if (!student) return;
      if (!mt.imageUrl) return showToast("Upload a master template first");
      showToast("Preparing card\u2026");
      const text = `${student.name} \u2014 Chest No ${student.chestNo}, ${student.category} at ${state.hero.title}`;
      drawMasterCard(student).then((url) => shareImageWithText(url, `${student.chestNo}-chest-no-card.jpg`, text))
        .catch(() => showToast("Could not generate card"));
    });

    if (!super_) return; // everything below is super-admin only

    document.querySelectorAll(".btn-save-start").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.category;
        const safeId = cat.replace(/[^a-zA-Z0-9]/g, "_");
        const val = parseInt(document.getElementById(`start_${safeId}`).value, 10);
        if (!val || val < 1) return showToast("Enter a valid start number");
        state.categoryStartNumbers[cat] = val;
        persist();
        showToast(`Start number for ${cat} set to ${val}`);
        renderChestNumberTab();
      });
    });

    document.getElementById("btnAddCategory").addEventListener("click", () => {
      const name = document.getElementById("newCategoryName").value.trim();
      if (!name) return showToast("Enter a category name");
      if (state.categories.includes(name)) return showToast("That category already exists");
      const highestStart = Object.values(state.categoryStartNumbers).reduce((m, v) => Math.max(m, v), 0);
      const nextStart = Math.floor(highestStart / 100) * 100 + 100;
      state.categories.push(name);
      state.categoryStartNumbers[name] = nextStart;
      persist();
      showToast(`"${name}" added \u2014 starts at ${nextStart}`);
      renderChestNumberTab();
    });

    document.querySelectorAll(".btn-delete-category").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.category;
        if (state.categories.length <= 1) return showToast("At least one category must remain");
        const studentCount = state.students.filter((s) => s.category === cat).length;
        const eventCount = state.events.filter((e) => e.category === cat).length;
        if (studentCount || eventCount) {
          return showToast(`Can't delete "${cat}" \u2014 it still has ${studentCount} student(s) and ${eventCount} programme(s). Remove those first.`);
        }
        if (!confirm(`Delete the "${cat}" category? This cannot be undone.`)) return;
        state.categories = state.categories.filter((c) => c !== cat);
        delete state.categoryStartNumbers[cat];
        persist();
        showToast(`"${cat}" deleted`);
        renderChestNumberTab();
      });
    });

    document.getElementById("btnResetStudents").addEventListener("click", () => {
      if (!confirm(`Delete all ${state.students.length} registered student(s) and reset chest numbers? This cannot be undone.`)) return;
      state.students = [];
      persist();
      renderCounters();
      showToast("All students removed \u2014 chest numbers reset");
      renderChestNumberTab();
    });

    // ---- Master template upload ----
    const mtInput = document.getElementById("mtImageInput");
    if (mtInput) mtInput.addEventListener("change", () => {
      const file = mtInput.files[0];
      if (!file) return;
      showToast("Compressing template image\u2026");
      compressImageFile(file, 1013, 0.85).then((imageUrl) => {
        state.masterCardTemplate = { imageUrl, placements: defaultCardPlacements() };
        persist(); showToast("Master template uploaded"); renderChestNumberTab();
      }).catch(() => showToast("Could not process that image"));
    });
    const replaceBtn = document.getElementById("btnReplaceTemplate");
    if (replaceBtn) replaceBtn.addEventListener("click", () => {
      const inp = document.getElementById("mtImageInput");
      inp.style.display = "block";
      inp.click();
    });

  }

  /* ---- Teams tab ---- */
  const TEAM_COLOR_PALETTE = ["#155E43", "#8B2635", "#1F5FA8", "#C9A227", "#6B3FA0", "#B85C1E", "#0E7C7B", "#A6303F"];
  function renderTeamsTab() {
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">New Team</div>
        <div class="grid2" style="margin-bottom:.75rem">
          <input id="tName" class="input" placeholder="Team Name" />
          <input id="tLeader" class="input" placeholder="Team Leader" />
        </div>
        <button class="btn btn-primary" id="btnAddTeam" style="width:auto;padding:.6rem 1rem">+ Add Team</button>
      </div>
      <div id="teamsListWrap"></div>`;
    renderTeamsList();
    document.getElementById("btnAddTeam").addEventListener("click", () => {
      const name = document.getElementById("tName").value.trim();
      if (!name) return showToast("Team name is required");
      state.teams.push({
        id: uid(), name,
        color: TEAM_COLOR_PALETTE[state.teams.length % TEAM_COLOR_PALETTE.length],
        leader: document.getElementById("tLeader").value,
        assistant: "",
      });
      persist(); renderCounters(); renderLeaderboard(); renderTeamsTab();
      showToast("Team added");
    });
  }
  let teamEditId = null;     // which team is showing its inline edit form
  let teamLeaderPickId = null; // which team is showing its Change Leader dropdown

  function renderTeamsList() {
    document.getElementById("teamsListWrap").innerHTML = state.teams.map((t) => {
      const teamStudents = state.students.filter((s) => s.team === t.id);
      return `
      <div class="card">
        ${teamEditId === t.id ? `
        <div class="grid2" style="margin-bottom:.5rem">
          <input class="input" data-edit-name value="${escapeAttr(t.name)}" placeholder="Team Name" />
          <input type="color" class="input" data-edit-color value="${t.color}" style="padding:.25rem" />
        </div>
        <input class="input" data-edit-assistant value="${escapeAttr(t.assistant || "")}" placeholder="Assistant Leader" style="margin-bottom:.5rem" />
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-primary" data-save-team="${t.id}" style="width:auto;padding:.45rem .9rem">Save</button>
          <button class="btn btn-ghost" data-cancel-edit style="width:auto;padding:.45rem .9rem">Cancel</button>
        </div>` : `
        <div class="row-between">
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="width:.75rem;height:.75rem;border-radius:50%;background:${t.color};display:inline-block"></span>
            <div><div style="font-size:.85rem;font-weight:500">${escapeHtml(t.name)}</div>
            <div class="muted" style="font-size:.7rem">Leader: ${escapeHtml(t.leader || "\u2014")} \u00b7 Asst: ${escapeHtml(t.assistant || "\u2014")}</div></div>
          </div>
          <div class="history-dots-wrap">
            <button class="history-dots-btn" data-team-menu="${t.id}">\u22EF</button>
            <div class="history-dots-menu hidden" data-id="${t.id}">
              <button class="history-menu-item" data-edit-team="${t.id}">Edit Team</button>
              <button class="history-menu-item" data-change-leader="${t.id}">Change Leader</button>
              <button class="history-menu-item danger" data-delete-team="${t.id}">Delete Team</button>
            </div>
          </div>
        </div>
        ${teamLeaderPickId === t.id ? `
        <div style="margin-top:.6rem;display:flex;gap:.5rem">
          ${teamStudents.length ? `
          <select class="input" data-leader-select="${t.id}" style="flex:1">
            <option value="">Select leader...</option>
            ${teamStudents.map((s) => `<option value="${escapeAttr(s.name)}" ${s.name === t.leader ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
          </select>
          <button class="btn btn-primary" data-save-leader="${t.id}" style="width:auto;padding:.5rem .9rem">Set</button>` : `
          <div class="muted" style="font-size:.72rem">No students registered in this team yet \u2014 add students first, or type a name below.</div>`}
        </div>
        ${!teamStudents.length ? `
        <div style="margin-top:.4rem;display:flex;gap:.5rem">
          <input class="input" data-leader-text="${t.id}" placeholder="Leader name" value="${escapeAttr(t.leader || "")}" style="flex:1" />
          <button class="btn btn-primary" data-save-leader="${t.id}" style="width:auto;padding:.5rem .9rem">Set</button>
        </div>` : ""}` : ""}`}
      </div>`;
    }).join("");

    document.querySelectorAll("[data-team-menu]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.dataset.teamMenu;
      document.querySelectorAll("#teamsListWrap .history-dots-menu").forEach((m) => { if (m.dataset.id !== id) m.classList.add("hidden"); });
      document.querySelector(`#teamsListWrap .history-dots-menu[data-id="${id}"]`).classList.toggle("hidden");
    }));
    document.querySelectorAll("[data-edit-team]").forEach((b) => b.addEventListener("click", () => {
      teamEditId = b.dataset.editTeam; teamLeaderPickId = null;
      renderTeamsList();
    }));
    document.querySelectorAll("[data-cancel-edit]").forEach((b) => b.addEventListener("click", () => {
      teamEditId = null; renderTeamsList();
    }));
    document.querySelectorAll("[data-save-team]").forEach((b) => b.addEventListener("click", () => {
      const team = state.teams.find((t) => t.id === b.dataset.saveTeam);
      const name = document.querySelector("[data-edit-name]").value.trim();
      if (!name) return showToast("Team name is required");
      team.name = name;
      team.color = document.querySelector("[data-edit-color]").value;
      team.assistant = document.querySelector("[data-edit-assistant]").value.trim();
      teamEditId = null;
      persist(); renderLeaderboard(); renderTeamsList();
      showToast("Team updated");
    }));
    document.querySelectorAll("[data-change-leader]").forEach((b) => b.addEventListener("click", () => {
      teamLeaderPickId = b.dataset.changeLeader; teamEditId = null;
      renderTeamsList();
    }));
    document.querySelectorAll("[data-save-leader]").forEach((b) => b.addEventListener("click", () => {
      const team = state.teams.find((t) => t.id === b.dataset.saveLeader);
      const select = document.querySelector(`[data-leader-select="${b.dataset.saveLeader}"]`);
      const text = document.querySelector(`[data-leader-text="${b.dataset.saveLeader}"]`);
      const newLeader = (select ? select.value : "") || (text ? text.value.trim() : "");
      if (!newLeader) return showToast("Choose or enter a leader name");
      team.leader = newLeader;
      teamLeaderPickId = null;
      persist(); renderTeamsList();
      showToast("Team leader updated");
    }));
    document.querySelectorAll("#teamsListWrap [data-delete-team]").forEach((b) => b.addEventListener("click", () => {
      const team = state.teams.find((t) => t.id === b.dataset.deleteTeam);
      if (!confirm(`Delete ${team ? team.name : "this team"}? This can't be undone.`)) return;
      removeTeamEverywhere(b.dataset.deleteTeam);
      state.teams = state.teams.filter((t) => t.id !== b.dataset.deleteTeam);
      persist(); renderCounters(); renderLeaderboard(); renderTeamsTab();
    }));
  }

  /* ---- Events tab ---- */
  function renderEventsTab() {
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">New Programme</div>
        <input id="evName" class="input" placeholder="Programme Name" style="margin-bottom:.5rem" />
        <div class="grid3" style="margin-bottom:.5rem">
          <select id="evCategory" class="input">${state.categories.map((c) => `<option>${c}</option>`).join("")}</select>
          <select id="evType" class="input"><option>Individual</option><option>Group</option></select>
          <select id="evGender" class="input"><option>General</option><option>Boys</option><option>Girls</option></select>
        </div>
        <div class="field-label" style="margin-bottom:.25rem">Programme Nature</div>
        <div class="grid2" style="margin-bottom:.75rem">
          <label class="radio-pill"><input type="radio" name="evStageType" value="Stage" checked /> \u{1F3A4} Stage</label>
          <label class="radio-pill"><input type="radio" name="evStageType" value="Off-stage" /> \u270D\uFE0F Off-stage</label>
        </div>
        <button class="btn btn-primary" id="btnAddEvent" style="width:auto;padding:.6rem 1rem">+ Add Programme</button>
      </div>
      <div id="eventsListWrap"></div>`;
    renderEventsList();
    document.getElementById("btnAddEvent").addEventListener("click", () => {
      const name = document.getElementById("evName").value.trim();
      if (!name) return showToast("Programme name is required");
      const stageTypeInput = document.querySelector('input[name="evStageType"]:checked');
      state.events.push({
        id: uid(), name,
        category: document.getElementById("evCategory").value,
        type: document.getElementById("evType").value,
        gender: document.getElementById("evGender").value,
        stageType: stageTypeInput ? stageTypeInput.value : "Stage",
        status: "pending",
        resultStatus: "Pending",
        assignedJudges: [...state.judges],
      });
      persist(); renderCounters(); renderTicker(); renderFilters(); renderResultsList(); renderEventsTab();
      showToast("Programme added");
    });
  }
  let eventEditId = null; // which programme is showing its inline edit form
  function renderEventsList() {
    document.getElementById("eventsListWrap").innerHTML = state.events.map((e) => {
      const participants = state.students.filter((s) => s.events.includes(e.id));
      if (eventEditId === e.id) return `<div class="card">
        <input class="input" data-edit-ev-name value="${escapeAttr(e.name)}" placeholder="Programme Name" style="margin-bottom:.5rem" />
        <div class="grid3" style="margin-bottom:.5rem">
          <select class="input" data-edit-ev-category>${state.categories.map((c) => `<option ${c === e.category ? "selected" : ""}>${c}</option>`).join("")}</select>
          <select class="input" data-edit-ev-type><option ${e.type === "Individual" ? "selected" : ""}>Individual</option><option ${e.type === "Group" ? "selected" : ""}>Group</option></select>
          <select class="input" data-edit-ev-gender>${["General", "Boys", "Girls"].map((g) => `<option ${g === e.gender ? "selected" : ""}>${g}</option>`).join("")}</select>
        </div>
        <div class="grid2" style="margin-bottom:.75rem">
          <label class="radio-pill"><input type="radio" name="editEvStageType-${e.id}" value="Stage" data-edit-ev-stagetype ${(e.stageType || "Stage") === "Stage" ? "checked" : ""} /> \u{1F3A4} Stage</label>
          <label class="radio-pill"><input type="radio" name="editEvStageType-${e.id}" value="Off-stage" data-edit-ev-stagetype ${e.stageType === "Off-stage" ? "checked" : ""} /> \u270D\uFE0F Off-stage</label>
        </div>
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-primary" data-save-event="${e.id}" style="width:auto;padding:.45rem .9rem">Save</button>
          <button class="btn btn-ghost" data-cancel-edit-event style="width:auto;padding:.45rem .9rem">Cancel</button>
        </div>
      </div>`;
      return `<div class="card">
        <div class="row-between">
          <div>
            <div style="font-size:.85rem;font-weight:500">${escapeHtml(e.name)} ${e.status === "ticked" ? '<span class="tick">\u2713</span>' : ""}</div>
            <div class="muted" style="font-size:.7rem">${e.category} \u00b7 ${e.type} \u00b7 ${e.stageType || "Stage"} \u00b7 ${e.gender} \u00b7 ${participants.length} registered \u00b7 <span style="color:${getResultStatus(e) === "Published" ? "var(--emerald-light)" : getResultStatus(e) === "Submitted" ? "var(--gold-light)" : "var(--muted)"}">${getResultStatus(e)}</span></div>
          </div>
          <div class="history-dots-wrap">
            <button class="history-dots-btn" data-id="${e.id}">&#8942;</button>
            <div class="history-dots-menu hidden" data-id="${e.id}">
              <button class="history-menu-item" data-edit-event="${e.id}">Edit</button>
              <button class="history-menu-item danger" data-del-event="${e.id}">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");
    document.querySelectorAll("#eventsListWrap .history-dots-btn").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll("#eventsListWrap .history-dots-menu").forEach((m) => { if (m.dataset.id !== b.dataset.id) m.classList.add("hidden"); });
      document.querySelector(`#eventsListWrap .history-dots-menu[data-id="${b.dataset.id}"]`).classList.toggle("hidden");
    }));
    document.querySelectorAll("#eventsListWrap [data-edit-event]").forEach((b) => b.addEventListener("click", () => {
      eventEditId = b.dataset.editEvent;
      renderEventsList();
    }));
    document.querySelectorAll("#eventsListWrap [data-cancel-edit-event]").forEach((b) => b.addEventListener("click", () => {
      eventEditId = null;
      renderEventsList();
    }));
    document.querySelectorAll("#eventsListWrap [data-save-event]").forEach((b) => b.addEventListener("click", () => {
      const ev = state.events.find((e) => e.id === b.dataset.saveEvent);
      const name = document.querySelector("[data-edit-ev-name]").value.trim();
      if (!name) return showToast("Programme name is required");
      const stageInput = document.querySelector("[data-edit-ev-stagetype]:checked");
      ev.name = name;
      ev.category = document.querySelector("[data-edit-ev-category]").value;
      ev.type = document.querySelector("[data-edit-ev-type]").value;
      ev.gender = document.querySelector("[data-edit-ev-gender]").value;
      ev.stageType = stageInput ? stageInput.value : (ev.stageType || "Stage");
      eventEditId = null;
      persist(); renderCounters(); renderTicker(); renderFilters(); renderResultsList(); renderEventsList();
      showToast("Programme updated");
    }));
    document.querySelectorAll("#eventsListWrap [data-del-event]").forEach((b) => b.addEventListener("click", () => {
      const ev = state.events.find((e) => e.id === b.dataset.delEvent);
      if (!confirm(`Delete ${ev ? ev.name : "this programme"}? This can't be undone.`)) return;
      removeEventEverywhere(b.dataset.delEvent);
      state.events = state.events.filter((e) => e.id !== b.dataset.delEvent);
      persist(); renderCounters(); renderTicker(); renderFilters(); renderResultsList(); renderEventsTab();
    }));
  }

  /* ---- Competitions tab ----
     Read-only view for the admin to quickly check exactly who is competing
     in a given programme (every registered student and their team) —
     filter by category or search by programme name, then open the "..."
     menu on a row to see the full participant list for that programme. */
  function renderCompetitionsTab() {
    let compCategory = "";
    let compSearch = "";
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Competitions</div>
        <div class="field-label" style="margin-bottom:.5rem">Filter by category or search by programme name, then open the \u22EF menu on a row to see exactly which students (and teams) are competing in it.</div>
        <div class="grid3" style="margin-bottom:0">
          <select id="compCategoryFilter" class="input">
            <option value="">All Categories</option>
            ${state.categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
          <input id="compSearchInput" class="input" placeholder="Search programme name\u2026" style="grid-column:span 2" />
        </div>
      </div>
      <div id="compListWrap"></div>`;

    function draw() {
      const filtered = state.events.filter((e) =>
        (!compCategory || e.category === compCategory) &&
        (!compSearch || e.name.toLowerCase().includes(compSearch))
      );
      document.getElementById("compListWrap").innerHTML = filtered.length
        ? filtered.map((e) => {
            const participants = state.students.filter((s) => s.events.includes(e.id));
            return `<div class="card">
              <div class="row-between">
                <div>
                  <div style="font-size:.85rem;font-weight:500">${escapeHtml(e.name)}</div>
                  <div class="muted" style="font-size:.7rem">${e.category} \u00b7 ${e.type} \u00b7 ${e.gender} \u00b7 ${participants.length} registered</div>
                </div>
                <button class="dots-btn" data-open-comp="${e.id}">\u22EF</button>
              </div>
            </div>`;
          }).join("")
        : `<div class="muted" style="font-size:.8rem;padding:.5rem 0">No programmes match this filter.</div>`;
      document.querySelectorAll("[data-open-comp]").forEach((b) => b.addEventListener("click", () => openParticipantsModal(b.dataset.openComp)));
    }

    document.getElementById("compCategoryFilter").addEventListener("change", (e) => { compCategory = e.target.value; draw(); });
    document.getElementById("compSearchInput").addEventListener("input", (e) => { compSearch = e.target.value.trim().toLowerCase(); draw(); });
    draw();
  }

  // Read-only participant list for one programme \u2014 every registered student
  // (not collapsed to group leaders, unlike Mark Entry) with their team, so
  // the admin can see exactly who is competing in it.
  function openParticipantsModal(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event) return;
    const participants = state.students.filter((s) => s.events.includes(eventId));
    modalBody.innerHTML = `
      <div class="marks-modal">
        <div class="row-between" style="margin-bottom:.75rem">
          <div style="font-weight:600;font-size:.95rem">${escapeHtml(event.name)} \u2014 ${event.category}${event.gender !== "General" ? " (" + event.gender + " Only)" : ""}</div>
          <button class="dots-btn" id="pmClose" style="font-size:1.2rem">&times;</button>
        </div>
        <div class="marks-table-wrap">
          <table class="marks-table">
            <thead><tr><th>Student</th><th>Team</th><th>Chest #</th></tr></thead>
            <tbody>
              ${participants.length ? participants.map((s) => {
                const team = state.teams.find((t) => t.id === s.team);
                return `<tr>
                  <td style="text-align:left">${escapeHtml(s.name || "")}</td>
                  <td>${team ? escapeHtml(team.name) : "\u2014"}</td>
                  <td>${s.chestNo || "\u2014"}</td>
                </tr>`;
              }).join("") : `<tr><td colspan="3" class="muted">No students registered for this programme yet.</td></tr>`}
            </tbody>
          </table>
        </div>
        <div class="modal-actions" style="background:transparent;padding:.6rem 0 0">
          <button class="btn btn-ghost" id="pmCancel">Close</button>
        </div>
      </div>`;
    document.getElementById("pmClose").addEventListener("click", closeTopScreen);
    document.getElementById("pmCancel").addEventListener("click", closeTopScreen);
    modalOverlay.classList.remove("hidden");
    modalBody.classList.add("wide-modal");
    pushScreen(() => { modalOverlay.classList.add("hidden"); modalBody.classList.remove("wide-modal"); modalBody.innerHTML = ""; });
  }

  /* ---- Top Score tab: overall leaderboard + Vocal/Pen of the Fest ---- */
  function renderTopScoreTab() {
    const board = computeTopScoreLeaderboard();
    const scored = board.filter((row) => row.total > 0);

    let vocal = null, pen = null;
    scored.forEach((row) => {
      if (row.stageTotal > 0 && (!vocal || row.stageTotal > vocal.stageTotal)) vocal = row;
      if (row.offStageTotal > 0 && (!pen || row.offStageTotal > pen.offStageTotal)) pen = row;
    });

    function highlightCard(label, icon, row, value, color) {
      if (!row) return "";
      return `
      <div class="card" style="background:linear-gradient(135deg,${color}2e,${color}0d);border:1px solid ${color}">
        <div style="font-size:.7rem;font-weight:700;letter-spacing:.06em;color:${color};margin-bottom:.25rem">${icon} ${label}</div>
        <div style="font-size:1rem;font-weight:700">${escapeHtml(row.student.name)}</div>
        <div class="muted" style="font-size:.72rem">${row.student.chestNo} \u00b7 ${row.student.category} \u00b7 ${value}</div>
      </div>`;
    }

    adminContent.innerHTML = `
      <div class="card-title" style="margin-bottom:.75rem">\u{1F31F} Top Score</div>
      ${highlightCard("VOCAL OF THE FEST", "\u{1F3A4}", vocal, `Stage total: <b>${vocal ? vocal.stageTotal : 0}</b>`, "#E4C767")}
      ${highlightCard("PEN OF THE FEST", "\u270D\uFE0F", pen, `Off-stage total: <b>${pen ? pen.offStageTotal : 0}</b>`, "#1F7A57")}

      ${!scored.length ? `<div class="empty-note">No marks entered yet.</div>` : `
      <div class="card" style="padding:.5rem .75rem;margin-top:.75rem">
        ${scored.map((row, i) => {
          const isVocal = vocal && row.student.id === vocal.student.id;
          const isPen = pen && row.student.id === pen.student.id;
          return `
          <div class="history-row">
            <div style="display:flex;align-items:center;gap:.6rem">
              <div style="width:1.7rem;height:1.7rem;font-size:.75rem;flex-shrink:0;border-radius:50%;background:var(--surface2);color:var(--muted);display:flex;align-items:center;justify-content:center;font-weight:700">${i + 1}</div>
              <div>
                <div class="history-row-title">${escapeHtml(row.student.name)} ${isVocal ? '<span style="color:var(--gold-light);font-weight:700;font-size:.68rem">\u2605 VOCAL</span>' : ""}${isPen ? '<span style="color:var(--emerald-light);font-weight:700;font-size:.68rem">\u2605 PEN</span>' : ""}</div>
                <div class="muted" style="font-size:.68rem">${row.student.chestNo} \u00b7 ${row.student.category}</div>
              </div>
            </div>
            <div style="font-weight:700">${row.total}</div>
          </div>`;
        }).join("")}
      </div>`}`;
  }


  function renderMarksTab() {
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Judges Panel</div>
        <div class="judge-chips" id="judgesChips">
          ${state.judges.map((j) => `<span class="judge-chip">${escapeHtml(j)} <button data-judge="${escapeAttr(j)}">&times;</button></span>`).join("")}
        </div>
        <div style="display:flex;gap:.5rem">
          <input id="newJudge" class="input" placeholder="Judge name" style="flex:1" />
          <button class="btn btn-primary" id="btnAddJudge" style="width:auto;padding:.5rem .9rem">+ Add</button>
        </div>
      </div>
      <div class="marks-table-wrap">
        <table class="marks-table">
          <thead><tr><th>Competition</th><th>Category</th><th>Gender</th><th>Sign</th><th>Status</th><th></th></tr></thead>
          <tbody id="marksTableBody"></tbody>
        </table>
      </div>`;

    document.getElementById("btnAddJudge").addEventListener("click", () => {
      const v = document.getElementById("newJudge").value.trim();
      if (!v) return;
      if (!state.judges.includes(v)) state.judges.push(v);
      persist(); renderMarksTab();
    });
    document.querySelectorAll("#judgesChips [data-judge]").forEach((b) => b.addEventListener("click", () => {
      state.judges = state.judges.filter((j) => j !== b.dataset.judge);
      state.events.forEach((e) => { e.assignedJudges = e.assignedJudges.filter((j) => j !== b.dataset.judge); });
      persist(); renderMarksTab();
    }));

    document.getElementById("marksTableBody").innerHTML = state.events.map((e) => `
      <tr>
        <td style="text-align:left">${escapeHtml(e.name)}</td>
        <td>${e.category}</td>
        <td>${e.gender}</td>
        <td>${e.status === "ticked" ? '<span class="tick" title="Green Room Sign already generated">\u2713</span>' : '<span class="muted">\u2014</span>'}</td>
        <td>${(() => { const s = (state.marks[e.id] && Object.keys(state.marks[e.id]).length) ? "Submitted" : "Pending"; const cls = s === "Submitted" ? "status-submitted" : "status-pending"; return `<span class="status-pill ${cls}">${s}</span>`; })()}</td>
        <td><button class="dots-btn" data-open="${e.id}">\u22EF</button></td>
      </tr>`).join("");
    document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openMarksModal(b.dataset.open)));
  }

  function openMarksModal(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    if (!state.marks[eventId]) state.marks[eventId] = {};
    let sortMode = "code";

    function getSortedParticipants() {
      const participants = groupAwareParticipants(eventId);
      if (sortMode === "marks") {
        return [...participants].sort((a, b) => (finalMarkFor(eventId, b.id) ?? -Infinity) - (finalMarkFor(eventId, a.id) ?? -Infinity));
      }
      return [...participants].sort((a, b) => codeLetterFor(eventId, a.id).localeCompare(codeLetterFor(eventId, b.id)));
    }

    function draw() {
      const rows = getSortedParticipants();
      modalBody.innerHTML = `
        <div class="marks-modal">
          <div class="row-between" style="margin-bottom:.75rem">
            <div style="font-weight:600;font-size:.95rem">${escapeHtml(event.name)} \u2014 ${event.category}${event.gender !== "General" ? " (" + event.gender + " Only)" : ""}</div>
            <button class="dots-btn" id="meClose" style="font-size:1.2rem">&times;</button>
          </div>
          ${event.resultStatus === "Published" ? `<div class="warn-banner">\u26A0 Result already published. Go to the Results section to re-publish after changing marks.</div>` : ""}
          ${event.type === "Group" ? `<div class="muted" style="font-size:.7rem;margin-bottom:.5rem">\u2139 Group programme \u2014 each team is scored once, under its team leader (first member registered).</div>` : ""}
          <div class="field-label">Judges</div>
          <div class="judge-chips">
            ${state.judges.map((j) => `<span class="judge-chip" data-toggle-judge="${escapeAttr(j)}" style="cursor:pointer;${event.assignedJudges.includes(j) ? "" : "opacity:.4"}">${escapeHtml(j)}</span>`).join("") || '<span class="muted" style="font-size:.72rem">Add judges in the panel above first.</span>'}
          </div>
          <div class="marks-table-wrap" style="margin-top:.5rem">
            <table class="marks-table">
              <thead><tr>${event.type === "Group" ? "<th>Team</th><th>Leader</th>" : "<th>Chest #</th><th>Code</th>"}${event.assignedJudges.map((j) => `<th>${escapeHtml(j)}</th>`).join("")}<th>Final</th></tr></thead>
              <tbody>
                ${rows.map((student) => {
                  const team = state.teams.find((t) => t.id === student.team);
                  const marksSoFar = state.marks[eventId][student.id] || {};
                  const finalMark = finalMarkFor(eventId, student.id);
                  return `
                  <tr>
                    ${event.type === "Group"
                      ? `<td>${team ? escapeHtml(team.name) : "\u2014"}</td><td>${escapeHtml(student.name || "")}</td>`
                      : `<td>${student.chestNo || "\u2014"}</td><td><input type="text" maxlength="3" class="me-code-input" data-student="${student.id}" value="${escapeAttr(codeLetterFor(eventId, student.id))}" style="width:2.6rem;text-align:center;text-transform:uppercase" /></td>`}
                    ${event.assignedJudges.map((j) => `<td><input type="number" class="me-mark-input" min="0" max="100" step="0.01" inputmode="decimal" data-student="${student.id}" data-judge="${escapeAttr(j)}" value="${marksSoFar[j] ?? ""}" /></td>`).join("")}
                    <td><b>${finalMark ?? "\u2014"}</b></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
          <div class="sort-row">
            <button class="sort-btn" id="sortByCode">Sort by Code Letter</button>
            <button class="sort-btn" id="sortByMarks">Sort by Marks</button>
          </div>
          <div class="modal-actions" style="background:transparent;padding:0 0 .6rem">
            <button class="btn btn-ghost" id="meCancel">Cancel</button>
            <button class="btn btn-primary" id="meSubmit">Submit Marks</button>
          </div>
        </div>`;

      document.getElementById("meClose").addEventListener("click", closeTopScreen);
      document.getElementById("meCancel").addEventListener("click", closeTopScreen);
      document.getElementById("sortByCode").addEventListener("click", () => { sortMode = "code"; draw(); });
      document.getElementById("sortByMarks").addEventListener("click", () => { sortMode = "marks"; draw(); });
      document.querySelectorAll("[data-toggle-judge]").forEach((chip) => chip.addEventListener("click", () => {
        const j = chip.dataset.toggleJudge;
        if (event.assignedJudges.includes(j)) event.assignedJudges = event.assignedJudges.filter((x) => x !== j);
        else event.assignedJudges.push(j);
        draw();
      }));
      // Returns true if every entered mark is a valid number from 0\u2013100 (blank is
      // allowed \u2014 it just means "not marked yet"). Invalid entries are flagged
      // on-screen instead of being silently saved as broken data.
      function collectMarks() {
        let valid = true;
        const touchedStudents = new Set();
        if (!state.codes[eventId]) state.codes[eventId] = {};
        document.querySelectorAll(".me-code-input").forEach((inp) => {
          const sid = inp.dataset.student;
          const v = inp.value.trim().toUpperCase();
          if (v) state.codes[eventId][sid] = v;
          else delete state.codes[eventId][sid];
        });
        document.querySelectorAll(".me-mark-input").forEach((inp) => {
          const sid = inp.dataset.student, j = inp.dataset.judge;
          if (!state.marks[eventId][sid]) state.marks[eventId][sid] = {};
          touchedStudents.add(sid);
          const raw = inp.value.trim();
          if (raw === "") {
            delete state.marks[eventId][sid][j]; // bug fix: clearing a mark now removes it, not just blanks it
            inp.classList.remove("input-error");
            return;
          }
          const num = Number(raw);
          if (isNaN(num) || num < 0 || num > 100) {
            valid = false;
            inp.classList.add("input-error");
            return;
          }
          inp.classList.remove("input-error");
          state.marks[eventId][sid][j] = Math.round(num * 100) / 100;
        });
        // If every judge's mark was cleared for a student, drop their empty
        // entry entirely so Dashboard counts (e.g. Marks Entered) don't keep
        // counting a student who no longer has any mark.
        touchedStudents.forEach((sid) => {
          if (state.marks[eventId][sid] && Object.keys(state.marks[eventId][sid]).length === 0) delete state.marks[eventId][sid];
        });
        return valid;
      }
      document.getElementById("meSubmit").addEventListener("click", () => {
        if (!collectMarks()) { showToast("Marks must be numbers between 0 and 100 \u2014 check the highlighted boxes"); return; }
        persist(); showToast("Marks saved"); draw(); renderMarksTab();
      });
    }

    draw();
    modalOverlay.classList.remove("hidden");
    modalBody.classList.add("wide-modal");
    pushScreen(() => { modalOverlay.classList.add("hidden"); modalBody.classList.remove("wide-modal"); modalBody.innerHTML = ""; });
  }

  /* ---- Limits tab ---- */
  function renderLimitsTab() {
    const groupEvents = state.events.filter((e) => e.type === "Group");
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Global Event Limits</div>
        <div class="grid2" style="margin-bottom:.75rem">
          <div><div class="field-label">Max Individual Events</div><input id="limIndiv" type="number" min="0" class="input" value="${state.limits.maxIndividual}" /></div>
          <div><div class="field-label">Max Group Events</div><input id="limGroup" type="number" min="0" class="input" value="${state.limits.maxGroup}" /></div>
        </div>
        <div class="muted" style="font-size:.7rem;margin:.1rem 0 .4rem">Programme type limit \u2014 how many Stage / Off-stage items a student can join, on top of the Individual/Group caps above.</div>
        <div class="grid2" style="margin-bottom:.75rem">
          <div><div class="field-label">\u{1F3A4} Max Stage Events</div><input id="limStage" type="number" min="0" class="input" value="${state.limits.maxStage}" /></div>
          <div><div class="field-label">\u270D\uFE0F Max Off-stage Events</div><input id="limOffStage" type="number" min="0" class="input" value="${state.limits.maxOffStage}" /></div>
        </div>
        <button class="btn btn-primary" id="btnSaveLimits" style="width:auto;padding:.6rem 1rem">Save Limits</button>
      </div>
      <div class="card">
        <div class="card-title">Group Item \u2014 Members Per Team</div>
        <div class="muted" style="font-size:.75rem;margin-bottom:.75rem">Every Group-type programme appears here automatically. Set how many students from one team can join each \u2014 once a team hits the limit, no more of its members can be added to that programme.</div>
        ${groupEvents.length ? groupEvents.map((e) => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <div style="font-size:.85rem;font-weight:600">${escapeHtml(e.name)}</div>
              <div style="font-size:.7rem;color:var(--muted)">${escapeHtml(e.category)}</div>
            </div>
            <input type="number" min="1" class="input" data-group-limit="${e.id}" value="${e.groupLimit || 4}" style="width:4.5rem;text-align:center" />
          </div>`).join("") : `<div class="muted" style="font-size:.8rem">No Group-type programmes yet \u2014 add one in the Programme tab first.</div>`}
        ${groupEvents.length ? `<button class="btn btn-primary" id="btnSaveGroupLimits" style="width:auto;padding:.6rem 1rem;margin-top:.85rem">Save Group Limits</button>` : ""}
      </div>`;
    document.getElementById("btnSaveLimits").addEventListener("click", () => {
      state.limits = {
        maxIndividual: Number(document.getElementById("limIndiv").value) || 0,
        maxGroup: Number(document.getElementById("limGroup").value) || 0,
        maxStage: Number(document.getElementById("limStage").value) || 0,
        maxOffStage: Number(document.getElementById("limOffStage").value) || 0,
      };
      persist(); showToast("Limits updated");
    });
    const saveGroupBtn = document.getElementById("btnSaveGroupLimits");
    if (saveGroupBtn) saveGroupBtn.addEventListener("click", () => {
      document.querySelectorAll("[data-group-limit]").forEach((input) => {
        const ev = state.events.find((e) => e.id === input.dataset.groupLimit);
        if (ev) ev.groupLimit = Math.max(1, Number(input.value) || 1);
      });
      persist(); showToast("Group limits updated");
    });
  }

  /* ---- Students / Participants tab ---- */
  let studentForm = { name: "", cls: "", phone: "", gender: "Boys", category: state.categories[0], team: state.teams[0] ? state.teams[0].id : "", events: [] };
  let studentsView = { mode: "list", id: null };
  // The student profile subview used to be a plain in-memory toggle with no
  // history entry of its own — so hardware back / swipe (which only know
  // about screenStack) skipped straight past it to whatever was already on
  // the stack (the Admin Dashboard "return" step), instead of landing back
  // on the Students list. Now it gets its own tracked back-navigation step.
  let profileScreenPushed = false;
  function studentProfileCloseFn() {
    profileScreenPushed = false;
    studentsView = { mode: "list", id: null };
    renderStudentsTab();
  }

  function eligibleEventsFor(gender, category) {
    return state.events.filter((e) => e.category === category && (e.gender === gender || e.gender === "General"));
  }

  function renderStudentsTab() {
    if (studentsView.mode === "profile" && state.students.some((s) => s.id === studentsView.id)) {
      return renderStudentProfile(studentsView.id);
    }
    studentsView = { mode: "list", id: null };
    studentForm.team = studentForm.team || (state.teams[0] ? state.teams[0].id : "");
    const eligible = eligibleEventsFor(studentForm.gender, studentForm.category);
    const selIndiv = studentForm.events.filter((id) => state.events.find((e) => e.id === id)?.type === "Individual").length;
    const selGroup = studentForm.events.filter((id) => state.events.find((e) => e.id === id)?.type === "Group").length;
    const selStage = studentForm.events.filter((id) => (state.events.find((e) => e.id === id)?.stageType || "Stage") === "Stage").length;
    const selOffStage = studentForm.events.filter((id) => state.events.find((e) => e.id === id)?.stageType === "Off-stage").length;

    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Register Student</div>
        <div class="grid2" style="margin-bottom:.5rem">
          <input id="sName" class="input" placeholder="Full Name" value="${escapeAttr(studentForm.name)}" />
          <input id="sClass" class="input" placeholder="Class" value="${escapeAttr(studentForm.cls)}" />
        </div>
        <input id="sPhone" class="input" placeholder="Phone" style="margin-bottom:.5rem" value="${escapeAttr(studentForm.phone)}" />
        <div class="grid3" style="margin-bottom:.6rem">
          <select id="sGender" class="input">
            <option ${studentForm.gender === "Boys" ? "selected" : ""}>Boys</option>
            <option ${studentForm.gender === "Girls" ? "selected" : ""}>Girls</option>
          </select>
          <select id="sCategory" class="input">${state.categories.map((c) => `<option ${studentForm.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>
          <select id="sTeam" class="input">${state.teams.map((t) => `<option value="${t.id}" ${studentForm.team === t.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select>
        </div>
        <div class="row-between" style="margin-bottom:.4rem">
          <span class="muted" style="font-size:.68rem">Eligible Programmes (${studentForm.category}, ${studentForm.gender}/General)</span>
          <span class="muted" style="font-size:.65rem;font-family:'JetBrains Mono',monospace">${selIndiv}/${state.limits.maxIndividual} indiv \u00b7 ${selGroup}/${state.limits.maxGroup} group \u00b7 ${selStage}/${state.limits.maxStage} stage \u00b7 ${selOffStage}/${state.limits.maxOffStage} off-stage</span>
        </div>
        <div class="checkbox-list" id="checkList">
          ${eligible.length === 0 ? `<div class="muted" style="font-size:.72rem;font-style:italic">No programmes match this category/gender.</div>` :
            eligible.map((ev) => {
              const checked = studentForm.events.includes(ev.id);
              const stageType = ev.stageType || "Stage";
              const disabled = !checked && ((ev.type === "Individual" && selIndiv >= state.limits.maxIndividual) || (ev.type === "Group" && (selGroup >= state.limits.maxGroup || groupTeamFull(ev.id, studentForm.team))) || (stageType === "Stage" && selStage >= state.limits.maxStage) || (stageType === "Off-stage" && selOffStage >= state.limits.maxOffStage));
              return `<label class="checkbox-row ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}">
                <input type="checkbox" data-ev="${ev.id}" data-type="${ev.type}" data-stagetype="${stageType}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
                ${escapeHtml(ev.name)} <span style="margin-left:auto;font-size:.6rem;text-transform:uppercase">${ev.type} \u00b7 ${stageType}</span>
              </label>`;
            }).join("")}
        </div>
        <button class="btn btn-primary" id="btnAddStudent" style="width:auto;padding:.6rem 1rem">+ Register &amp; Generate Chest No.</button>
      </div>
      <div style="font-size:.75rem;font-weight:500;color:var(--gold-light);margin:1rem 0 .5rem">Registered Students (${state.students.length})</div>
      <div class="muted" style="font-size:.68rem;margin:-.35rem 0 .6rem">Tap a student to view/edit their profile and programmes.</div>
      <div id="studentsListWrap"></div>`;

    renderStudentsList();

    document.getElementById("sName").addEventListener("input", (e) => { studentForm.name = e.target.value; });
    document.getElementById("sClass").addEventListener("input", (e) => { studentForm.cls = e.target.value; });
    document.getElementById("sPhone").addEventListener("input", (e) => { studentForm.phone = e.target.value; });
    document.getElementById("sGender").addEventListener("change", (e) => { studentForm.gender = e.target.value; studentForm.events = []; renderStudentsTab(); });
    document.getElementById("sCategory").addEventListener("change", (e) => { studentForm.category = e.target.value; studentForm.events = []; renderStudentsTab(); });
    document.getElementById("sTeam").addEventListener("change", (e) => { studentForm.team = e.target.value; });
    document.querySelectorAll("#checkList input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const evId = cb.dataset.ev;
        if (cb.checked) {
          const type = cb.dataset.type;
          const stageType = cb.dataset.stagetype;
          const count = studentForm.events.filter((id) => state.events.find((e) => e.id === id)?.type === type).length;
          const limit = type === "Individual" ? state.limits.maxIndividual : state.limits.maxGroup;
          if (count >= limit) { cb.checked = false; showToast("Maximum event limit reached for this student"); return; }
          const stageCount = studentForm.events.filter((id) => (state.events.find((e) => e.id === id)?.stageType || "Stage") === stageType).length;
          const stageLimit = stageType === "Stage" ? state.limits.maxStage : state.limits.maxOffStage;
          if (stageCount >= stageLimit) { cb.checked = false; showToast(`Maximum ${stageType} programme limit reached for this student`); return; }
          studentForm.events.push(evId);
        } else {
          studentForm.events = studentForm.events.filter((id) => id !== evId);
        }
        renderStudentsTab();
      });
    });
    document.getElementById("btnAddStudent").addEventListener("click", () => {
      const name = studentForm.name.trim();
      if (!name) return showToast("Student name is required");
      if (!studentForm.team) return showToast("Please select a team");
      const chestNo = nextChestNo(studentForm.category);
      state.students.push({
        id: uid(), name, cls: studentForm.cls, phone: studentForm.phone,
        gender: studentForm.gender, team: studentForm.team, category: studentForm.category, chestNo, events: [...studentForm.events],
      });
      persist(); renderCounters();
      showToast(`Student registered \u2014 chest no. ${chestNo}`);
      studentForm.name = ""; studentForm.cls = ""; studentForm.phone = ""; studentForm.events = [];
      renderStudentsTab();
    });
  }

  function renderStudentsList() {
    document.getElementById("studentsListWrap").innerHTML = state.students.map((s) => {
      const team = state.teams.find((t) => t.id === s.team);
      return `<div class="card student-card" data-open="${s.id}" style="cursor:pointer">
        <div class="row-between">
          <div>
            <div style="font-size:.85rem;font-weight:500">${escapeHtml(s.name)} <span style="font-family:'JetBrains Mono',monospace;font-size:.72rem;color:var(--gold)">${s.chestNo}</span></div>
            <div class="muted" style="font-size:.7rem">${s.category} \u00b7 ${s.gender} \u00b7 ${team ? escapeHtml(team.name) : ""} \u00b7 ${s.events.length} events</div>
          </div>
          <div class="history-dots-wrap">
            <button class="history-dots-btn" data-id="${s.id}">&#8942;</button>
            <div class="history-dots-menu hidden" data-id="${s.id}">
              <button class="history-menu-item danger" data-del-student="${s.id}">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");
    document.querySelectorAll("#studentsListWrap .student-card").forEach((card) => card.addEventListener("click", (e) => {
      if (e.target.closest(".history-dots-wrap")) return;
      studentsView = { mode: "profile", id: card.dataset.open };
      renderStudentsTab();
      if (!profileScreenPushed) { profileScreenPushed = true; pushScreen(studentProfileCloseFn); }
    }));
    document.querySelectorAll("#studentsListWrap .history-dots-btn").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll("#studentsListWrap .history-dots-menu").forEach((m) => { if (m.dataset.id !== b.dataset.id) m.classList.add("hidden"); });
      document.querySelector(`#studentsListWrap .history-dots-menu[data-id="${b.dataset.id}"]`).classList.toggle("hidden");
    }));
    document.querySelectorAll("#studentsListWrap [data-del-student]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const student = state.students.find((s) => s.id === b.dataset.delStudent);
      if (!confirm(`Delete ${student ? student.name : "this student"}? This can't be undone.`)) return;
      removeStudentEverywhere(b.dataset.delStudent);
      state.students = state.students.filter((s) => s.id !== b.dataset.delStudent);
      persist(); renderCounters(); renderStudentsTab();
    }));
  }

  // Student profile screen \u2014 view/edit name, class, phone, category, team and
  // programmes for an already-registered student, or delete them entirely.
  function renderStudentProfile(studentId) {
    const student = state.students.find((s) => s.id === studentId);
    if (!student) { studentsView = { mode: "list", id: null }; return renderStudentsTab(); }

    const eligible = eligibleEventsFor(student.gender, student.category);
    const selIndiv = student.events.filter((id) => state.events.find((e) => e.id === id)?.type === "Individual").length;
    const selGroup = student.events.filter((id) => state.events.find((e) => e.id === id)?.type === "Group").length;
    const selStage = student.events.filter((id) => (state.events.find((e) => e.id === id)?.stageType || "Stage") === "Stage").length;
    const selOffStage = student.events.filter((id) => state.events.find((e) => e.id === id)?.stageType === "Off-stage").length;

    adminContent.innerHTML = `
      <button class="link-btn" id="btnProfileBack" style="text-align:left;color:var(--gold-light);padding:0;margin-bottom:.75rem">&larr; Back to list</button>
      <div class="card">
        <div class="card-title">Student Profile \u2014 <span style="font-family:'JetBrains Mono',monospace;color:var(--gold)">${student.chestNo}</span></div>
        <div class="grid2" style="margin-bottom:.5rem">
          <input id="pName" class="input" placeholder="Full Name" value="${escapeAttr(student.name)}" />
          <input id="pClass" class="input" placeholder="Class" value="${escapeAttr(student.cls || "")}" />
        </div>
        <input id="pPhone" class="input" placeholder="Phone" style="margin-bottom:.5rem" value="${escapeAttr(student.phone || "")}" />
        <div class="grid3" style="margin-bottom:.6rem">
          <select id="pGender" class="input">
            <option ${student.gender === "Boys" ? "selected" : ""}>Boys</option>
            <option ${student.gender === "Girls" ? "selected" : ""}>Girls</option>
          </select>
          <select id="pCategory" class="input">${state.categories.map((c) => `<option ${student.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>
          <select id="pTeam" class="input">${state.teams.map((t) => `<option value="${t.id}" ${student.team === t.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select>
        </div>
        <div class="muted" style="font-size:.65rem;margin-bottom:.6rem">Changing category/gender refreshes the eligible programme list below \u2014 save to apply.</div>
        <div class="row-between" style="margin-bottom:.4rem">
          <span class="muted" style="font-size:.68rem">Programmes (${student.category}, ${student.gender}/General)</span>
          <span class="muted" style="font-size:.65rem;font-family:'JetBrains Mono',monospace">${selIndiv}/${state.limits.maxIndividual} indiv \u00b7 ${selGroup}/${state.limits.maxGroup} group \u00b7 ${selStage}/${state.limits.maxStage} stage \u00b7 ${selOffStage}/${state.limits.maxOffStage} off-stage</span>
        </div>
        <div class="checkbox-list" id="pCheckList">
          ${eligible.length === 0 ? `<div class="muted" style="font-size:.72rem;font-style:italic">No programmes match this category/gender.</div>` :
            eligible.map((ev) => {
              const checked = student.events.includes(ev.id);
              const stageType = ev.stageType || "Stage";
              const disabled = !checked && ((ev.type === "Individual" && selIndiv >= state.limits.maxIndividual) || (ev.type === "Group" && (selGroup >= state.limits.maxGroup || groupTeamFull(ev.id, student.team, student.id))) || (stageType === "Stage" && selStage >= state.limits.maxStage) || (stageType === "Off-stage" && selOffStage >= state.limits.maxOffStage));
              const leaderBadge = ev.type === "Group" && checked
                ? (isGroupLeader(ev.id, student.id) ? ` <span class="status-pill status-published" style="font-size:.55rem">TEAM LEADER</span>` : ` <span class="status-pill status-pending" style="font-size:.55rem">MEMBER</span>`)
                : "";
              return `<label class="checkbox-row ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}">
                <input type="checkbox" data-ev="${ev.id}" data-type="${ev.type}" data-stagetype="${stageType}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
                ${escapeHtml(ev.name)}${leaderBadge} <span style="margin-left:auto;font-size:.6rem;text-transform:uppercase">${ev.type} \u00b7 ${stageType}</span>
              </label>`;
            }).join("")}
        </div>
        <div class="muted" style="font-size:.63rem;margin:.3rem 0 .75rem">For group programmes, whichever member was registered first is the team leader \u2014 only the leader appears in published results.</div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-primary" id="btnSaveProfile" style="width:auto;padding:.6rem 1rem">\u2713 Save Changes</button>
          <button class="btn" id="btnDeleteProfile" style="width:auto;padding:.6rem 1rem;background:rgba(139,38,53,.12);color:var(--crimson)">Delete Student</button>
        </div>
      </div>`;

    // Local edit buffer so toggling checkboxes / switching category doesn't touch
    // Firebase until "Save Changes" is pressed.
    let draft = { name: student.name, cls: student.cls || "", phone: student.phone || "", gender: student.gender, category: student.category, team: student.team, events: [...student.events] };

    document.getElementById("btnProfileBack").addEventListener("click", () => {
      if (profileScreenPushed) closeTopScreen(); else studentProfileCloseFn();
    });
    document.getElementById("pName").addEventListener("input", (e) => { draft.name = e.target.value; });
    document.getElementById("pClass").addEventListener("input", (e) => { draft.cls = e.target.value; });
    document.getElementById("pPhone").addEventListener("input", (e) => { draft.phone = e.target.value; });
    document.getElementById("pTeam").addEventListener("change", (e) => { draft.team = e.target.value; });
    document.getElementById("pGender").addEventListener("change", (e) => {
      draft.gender = e.target.value; draft.events = [];
      Object.assign(student, draft); renderStudentProfile(studentId); // live-refresh eligible list only, not yet saved to Firebase
    });
    document.getElementById("pCategory").addEventListener("change", (e) => {
      draft.category = e.target.value; draft.events = [];
      Object.assign(student, draft); renderStudentProfile(studentId);
    });
    document.querySelectorAll("#pCheckList input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const evId = cb.dataset.ev;
        if (cb.checked) {
          const type = cb.dataset.type;
          const stageType = cb.dataset.stagetype;
          const count = draft.events.filter((id) => state.events.find((e) => e.id === id)?.type === type).length;
          const limit = type === "Individual" ? state.limits.maxIndividual : state.limits.maxGroup;
          if (count >= limit) { cb.checked = false; showToast("Maximum event limit reached for this student"); return; }
          const stageCount = draft.events.filter((id) => (state.events.find((e) => e.id === id)?.stageType || "Stage") === stageType).length;
          const stageLimit = stageType === "Stage" ? state.limits.maxStage : state.limits.maxOffStage;
          if (stageCount >= stageLimit) { cb.checked = false; showToast(`Maximum ${stageType} programme limit reached for this student`); return; }
          draft.events.push(evId);
        } else {
          draft.events = draft.events.filter((id) => id !== evId);
        }
        Object.assign(student, draft); renderStudentProfile(studentId);
      });
    });
    document.getElementById("btnSaveProfile").addEventListener("click", () => {
      if (!draft.name.trim()) return showToast("Student name is required");
      if (!draft.team) return showToast("Please select a team");
      Object.assign(student, { name: draft.name.trim(), cls: draft.cls, phone: draft.phone, gender: draft.gender, category: draft.category, team: draft.team, events: [...draft.events] });
      persist(); renderCounters();
      showToast("Student profile updated");
      renderStudentProfile(studentId);
    });
    document.getElementById("btnDeleteProfile").addEventListener("click", () => {
      if (!confirm(`Delete ${student.name}? This can't be undone.`)) return;
      removeStudentEverywhere(studentId);
      state.students = state.students.filter((s) => s.id !== studentId);
      persist(); renderCounters();
      showToast("Student deleted");
      if (profileScreenPushed) closeTopScreen(); else studentProfileCloseFn();
    });
  }

  /* ---- Gallery tab ---- */
  function renderGalleryTab() {
    const frameUrl = state.hero.galleryFrameUrl;
    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Photo Frame</div>
        <div class="field-label" style="margin-bottom:.5rem">Upload a decorative frame with a <b>transparent centre (PNG only)</b>. The frame is applied automatically only when a guest downloads or shares a photo \u2014 the gallery itself always shows the clean, unframed photo.</div>
        ${frameUrl ? `<div class="hero-photo-preview" style="background-image:url('${frameUrl}');background-color:#0B3D2E"></div>` : ""}
        <input type="file" id="gFrameFile" accept="image/png" class="input" style="margin:.5rem 0;padding:.4rem" />
        <div style="display:flex;gap:.5rem;margin-bottom:${frameUrl ? ".75rem" : "0"}">
          <button class="btn btn-primary" id="btnSaveFrame" style="width:auto;padding:.5rem .9rem">${frameUrl ? "Replace Frame" : "Upload Frame"}</button>
          ${frameUrl ? `<button class="btn btn-ghost" id="btnRemoveFrame" style="width:auto;padding:.5rem .9rem">Remove Frame</button>` : ""}
        </div>
        ${frameUrl ? `
        <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
          <input type="checkbox" id="gApplyFrameOnDownload" ${state.hero.applyFrameOnDownload === false ? "" : "checked"} />
          <span class="field-label" style="margin:0">Apply frame on download/share (turn off for madrasas that don't want the frame)</span>
        </label>` : ""}
      </div>
      <div class="card">
        <div class="card-title">Add Event Photo</div>
        <input type="file" id="gPhotoFile" accept="image/*" class="input" style="margin-bottom:.5rem;padding:.4rem" />
        <input id="gCaption" class="input" placeholder="Caption (e.g. Opening Ceremony)" style="margin-bottom:.75rem" />
        <button class="btn btn-primary" id="btnAddPhoto" style="width:auto;padding:.6rem 1rem">+ Add Photo</button>
        <div class="muted" style="font-size:.68rem;margin-top:.5rem">Photos are auto-compressed and converted to WebP before upload \u2014 sharp but small, so things stay fast for everyone.</div>
      </div>
      <div id="galleryAdminWrap" class="gallery-admin-grid"></div>`;

    document.getElementById("gFrameFile").addEventListener("change", () => {
      showToast("Frame selected \u2014 tap Upload Frame to save it");
    });
    document.getElementById("btnSaveFrame").addEventListener("click", () => {
      const file = document.getElementById("gFrameFile").files[0];
      if (!file) return showToast("Choose a PNG frame first");
      if (file.type !== "image/png") return showToast("Please choose a PNG file (needs a transparent centre)");
      showToast("Saving frame\u2026");
      compressImagePngFile(file, 1400).then((dataUrl) => {
        state.hero.galleryFrameUrl = dataUrl;
        persist(); renderGalleryTab();
        showToast("Frame saved \u2014 new photos will use it");
      }).catch(() => showToast("Could not process that frame image"));
    });
    const removeFrameBtn = document.getElementById("btnRemoveFrame");
    if (removeFrameBtn) removeFrameBtn.addEventListener("click", () => {
      delete state.hero.galleryFrameUrl;
      persist(); renderGalleryTab();
      showToast("Frame removed");
    });

    const applyFrameToggle = document.getElementById("gApplyFrameOnDownload");
    if (applyFrameToggle) applyFrameToggle.addEventListener("change", (e) => {
      state.hero.applyFrameOnDownload = e.target.checked;
      persist();
      showToast(e.target.checked ? "Frame will be applied on download" : "Frame will be skipped on download");
    });

    document.getElementById("gPhotoFile").addEventListener("change", () => {
      showToast("Photo selected \u2014 add a caption and tap Add Photo");
    });
    document.getElementById("btnAddPhoto").addEventListener("click", () => {
      const fileInput = document.getElementById("gPhotoFile");
      const caption = document.getElementById("gCaption").value.trim() || "Event Photo";
      const file = fileInput.files[0];
      if (!file) return showToast("Choose a photo first");
      showToast("Compressing & uploading photo\u2026");
      compressImageFile(file, 1000, 0.72).then((dataUrl) => uploadToImgBB(dataUrl)).then((finalUrl) => {
        state.gallery.push({ id: uid(), caption, color: "#155E43", url: finalUrl });
        persist(); renderGallery(); renderGalleryTab();
        showToast("Photo added to gallery");
      }).catch(() => showToast("Could not process that photo"));
    });
    renderGalleryAdminList();
  }
  function renderGalleryAdminList() {
    document.getElementById("galleryAdminWrap").innerHTML = state.gallery.map((p) => `
      <div class="gallery-admin-tile" style="${p.url ? "" : `background:linear-gradient(160deg, ${p.color}, #0B3D2E)`}">
        ${p.url ? `<img src="${p.url}" alt="${escapeAttr(p.caption)}" />` : ""}
        <button class="gdel" data-id="${p.id}">Delete</button>
        <span class="gcap">${escapeHtml(p.caption)}</span>
      </div>`).join("");
    document.querySelectorAll(".gdel").forEach((b) => b.addEventListener("click", () => {
      if (!confirm("Delete this photo? This can't be undone.")) return;
      state.gallery = state.gallery.filter((p) => p.id !== b.dataset.id);
      persist(); renderGallery(); renderGalleryTab();
    }));
  }

  /* ---- Export tab ---- */
  let pickEventKind = null;
  /* Fillable Valuation Sheet & Green Room Sign, used from inside the Green
     Room tab's card flow (no separate top-level tab). Valuation Sheet is for
     blind judging \u2014 only the Code Letter is shown, never chest no/name, so
     judges can't identify who they're marking. Green Room Sign shows chest
     no + name (auto-filled from registered participants) so students can
     sign in and be assigned a code letter before judging. Drafts save to
     localStorage per programme so nothing is lost on reload. */
  const PS_MAX_ROWS = 9;
  const PS_MARK_COLS = 5;

  function psLocalKey(type, eventId) { return `meelad_printsheet_${type}_${eventId}`; }
  function psLoadDraft(type, eventId, rowCount) {
    try {
      const saved = JSON.parse(localStorage.getItem(psLocalKey(type, eventId)));
      if (saved) {
        // If more students have registered for this programme since the sheet
        // was last opened, the saved draft (from that earlier, smaller
        // headcount) would otherwise keep showing the old, shorter row count.
        // Grow it to match \u2014 existing filled-in rows/marks are kept as-is,
        // only blank rows are appended at the end.
        if (type === "valuation" && rowCount && saved.rows && saved.rows.length < rowCount) {
          const extra = rowCount - saved.rows.length;
          for (let i = 0; i < extra; i++) saved.rows.push({ codeLetter: "", marks: Array(PS_MARK_COLS).fill(""), total: "" });
        }
        return saved;
      }
    } catch {}
    const rows = type === "valuation" ? Math.max(rowCount || PS_MAX_ROWS, 3) : PS_MAX_ROWS;
    return type === "valuation"
      ? { stageNo: "", rows: Array.from({ length: rows }, () => ({ codeLetter: "", marks: Array(PS_MARK_COLS).fill(""), total: "" })) }
      : { rows: {}, extraRows: [] };
  }
  function psSaveDraft(type, eventId, draft) {
    try { localStorage.setItem(psLocalKey(type, eventId), JSON.stringify(draft)); } catch {}
  }

  /* ===== Valuation Sheet: blind judging, Code Letter + PS_MARK_COLS marks +
     total out of 100. One programme per sheet \u2014 no name/chest no shown,
     so judges can't identify who they're marking. ===== */
  function renderValuationSheetInline(wrap, initialSheets) {
    const sheets = initialSheets.slice();

    const rowHtml = (row) => `
      <tr>
        <td style="height:2.9rem"></td>
        ${row.marks.map(() => `<td></td>`).join("")}
        <td></td>
      </tr>`;

    const previewBlock = (s) => {
      const draft = psLoadDraft("valuation", s.eventId, s.participants ? s.participants.length : undefined);
      draft.rows = draft.rows || [];
      s.draft = draft;
      return `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.25rem">
          <div>
            <div class="muted" style="font-size:.72rem">${escapeHtml(state.hero.title)}</div>
            <div style="font-size:1.15rem;font-weight:700">Valuation Sheet</div>
          </div>
          <div class="muted" style="font-size:.68rem;white-space:nowrap">${new Date().toLocaleDateString("en-GB")}</div>
        </div>
        <hr class="print-hr" style="margin:.4rem 0 .75rem" />
        <div class="marks-table-wrap">
          <table class="marks-table ps-val-table" style="table-layout:fixed">
            <colgroup>
              <col style="width:3.6rem" />
              ${Array(PS_MARK_COLS).fill(0).map(() => `<col style="width:4.6rem" />`).join("")}
              <col style="width:4.6rem" />
            </colgroup>
            <thead>
              <tr>
                <th colspan="2">${escapeHtml(s.event.name)}</th>
                <th colspan="${PS_MARK_COLS - 1}">${escapeHtml(s.event.category)}</th>
                <th>${escapeHtml(s.event.type || "Individual")}</th>
              </tr>
              <tr>
                <th>Code Letter</th>
                <th colspan="${PS_MARK_COLS}">Marks</th>
                <th>Mark out of 100</th>
              </tr>
            </thead>
            <tbody>${draft.rows.map(rowHtml).join("")}</tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:1.25rem;font-size:.7rem" class="muted">
          <div>Judge's Name and Signature :</div>
          <div>Judging Comments:</div>
        </div>
        <div style="border-bottom:1px solid var(--border);margin-top:2rem;width:33%"></div>`;
    };

    const printBlock = (s) => `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.25rem">
        <div>
          <div style="font-size:.8rem;font-weight:600">${escapeHtml(state.hero.title)}</div>
          <div style="font-size:1.35rem;font-weight:700">Valuation Sheet</div>
        </div>
        <div style="font-size:.75rem">${new Date().toLocaleDateString("en-GB")}</div>
      </div>
      <hr class="print-hr" />
      <table class="schedule-print-table" style="table-layout:fixed">
        <colgroup>
          <col style="width:15%" />
          ${Array(PS_MARK_COLS).fill(0).map(() => `<col style="width:${Math.floor(55 / PS_MARK_COLS)}%" />`).join("")}
          <col style="width:15%" />
        </colgroup>
        <thead>
          <tr><th colspan="2" style="text-align:center">${escapeHtml(s.event.name)}</th><th colspan="${PS_MARK_COLS - 1}" style="text-align:center">${escapeHtml(s.event.category)}</th><th style="text-align:center">${escapeHtml(s.event.type || "Individual")}</th></tr>
          <tr><th style="text-align:center">Code Letter</th><th colspan="${PS_MARK_COLS}" style="text-align:center">Marks</th><th style="text-align:center">Mark out of 100</th></tr>
        </thead>
        <tbody>${s.draft.rows.map((row) => `<tr><td style="height:2.6rem;text-align:center">${escapeHtml(row.codeLetter)}</td>${row.marks.map((m) => `<td style="text-align:center">${escapeHtml(String(m || ""))}</td>`).join("")}<td style="text-align:center"><b>${escapeHtml(String(row.total || ""))}</b></td></tr>`).join("")}</tbody>
      </table>
      <div style="margin-top:2rem;display:flex;justify-content:space-between;font-size:.85rem">
        <div>Judge's Name and Signature :</div>
        <div>Judging Comments:</div>
      </div>
      <div style="border-bottom:1px solid #333;margin-top:1.5rem;width:33%"></div>`;

    function renderAll() {
      // sheets[0] is the picked programme. "Add" duplicates it as a second
      // copy so the same programme's sheet fills both halves of one A4 page
      // \u2014 cut it and hand one half to each of two judges. Two sheets per
      // page (.ps-a4-pair/.ps-a4-half); a trailing odd sheet gets the top
      // half of its own page with the bottom half left blank.
      wrap.innerHTML = `
        <div class="card">
          ${sheets.map((s, i) => previewBlock(s) + (i < sheets.length - 1 ? `<div class="ps-cut-line">\u2702\ufe0f &nbsp;cut here&nbsp; \u2702\ufe0f</div>` : "")).join("")}
          <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem">
            <button class="btn btn-ghost" id="btnPsClose" style="flex:none;width:auto;padding:.4rem .9rem;font-size:.78rem">Cancel</button>
            <button class="btn btn-ghost" id="btnPsAdd" style="flex:none;width:auto;padding:.4rem .9rem;font-size:.78rem">+ Add (2nd judge copy)</button>
            <button class="btn btn-primary" id="btnPsPrint" style="flex:none;width:auto;padding:.4rem .9rem;font-size:.78rem;margin-left:auto">\u{1F5A8} Print${sheets.length > 1 ? ` (${sheets.length} copies)` : ""}</button>
          </div>
        </div>`;

      document.getElementById("btnPsClose").addEventListener("click", () => { wrap.innerHTML = ""; });

      document.getElementById("btnPsAdd").addEventListener("click", () => {
        const base = sheets[0];
        sheets.push({ event: base.event, eventId: base.eventId, participants: base.participants });
        renderAll();
        wrap.scrollIntoView({ behavior: "smooth", block: "end" });
      });

      // One tap = one print dialog. #printOverlay has to be populated because
      // the site's print CSS only allows #printOverlay to be visible on paper
      // (everything else is force-hidden). On mobile, window.print() doesn't
      // block until the dialog closes, so hiding the overlay right after
      // calling it (the old code) could hide the content before the PDF/print
      // engine captured it \u2014 producing a blank page. We wait for the
      // browser's "afterprint" event instead, with a timeout fallback.
      document.getElementById("btnPsPrint").addEventListener("click", () => {
        document.getElementById("printTitle").textContent = "Valuation Sheet";
        const pairs = [];
        for (let i = 0; i < sheets.length; i += 2) pairs.push([sheets[i], sheets[i + 1]]);
        document.getElementById("printContent").innerHTML = pairs.map((pair) => `
          <div class="ps-a4-pair">
            <div class="ps-a4-half">${printBlock(pair[0])}</div>
            <div class="ps-a4-half">${pair[1] ? printBlock(pair[1]) : ""}</div>
          </div>`).join("");
        document.getElementById("printOverlay").classList.remove("hidden");
        let hidden = false;
        const hideOverlay = () => {
          if (hidden) return;
          hidden = true;
          document.getElementById("printOverlay").classList.add("hidden");
          window.removeEventListener("afterprint", hideOverlay);
        };
        window.addEventListener("afterprint", hideOverlay);
        setTimeout(() => window.print(), 50);
        setTimeout(hideOverlay, 5000);
      });
    }

    renderAll();
  }

  /* ===== Green Room Sign: read-only preview built straight from registered
     participants \u2014 no typing on screen at all. Code Letter and Signature
     stay blank for the stage incharge to fill by hand at the venue. Accepts
     one or several programmes (picked via checkboxes) so a stage manager can
     print every Green Room Sign sheet for the day in a single print job \u2014
     each programme gets its own full page. ===== */
  function renderGreenRoomSheetInline(wrap, sheets) {
    const dateStr = new Date().toLocaleDateString("en-GB") + " " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    const sheetHtml = (s) => {
      const rows = s.participants.map((p) => `<tr><td>${p.chestNo}</td><td style="text-align:left">${escapeHtml(p.name)}</td><td></td><td></td></tr>`).join("");
      return `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.25rem">
        <div>
          <div class="muted" style="font-size:.72rem">${escapeHtml(state.hero.title)}</div>
          <div style="font-size:1.15rem;font-weight:700">Green Room Sign Sheet</div>
        </div>
        <div class="muted" style="font-size:.68rem;white-space:nowrap">${dateStr}</div>
      </div>
      <hr class="print-hr" style="margin:.4rem 0 .75rem" />
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;font-weight:700;font-size:.85rem">
        <div>${escapeHtml(s.event.name)}</div>
        <div class="muted" style="font-weight:500">${escapeHtml(s.event.type || "Individual")}</div>
        <div>${escapeHtml(s.event.category)}</div>
      </div>
      <div class="marks-table-wrap">
      <table class="schedule-print-table" style="table-layout:fixed">
        <thead><tr><th style="width:3.2rem">Chest No</th><th style="width:6.4rem">Participant</th><th style="width:4rem;white-space:normal">Code Letter</th><th style="width:6.8rem;white-space:normal">Participant's Signature</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
      <div style="margin-top:1.5rem;font-size:.78rem" class="muted">
        <div>Competition Start Time:</div>
        <div style="margin-top:.4rem">Competition End Time:</div>
      </div>
      <div style="text-align:center;margin-top:2rem;font-size:.78rem" class="muted">Stage incharge's Name and Signature</div>
      <div style="border-bottom:1px solid var(--border);margin:.4rem auto 0;width:50%"></div>`;
    };

    function renderAll() {
      wrap.innerHTML = `
        <div class="card">
          ${sheetHtml(sheets[0])}
          <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem">
            <button class="btn btn-ghost" id="btnPsClose" style="flex:none;width:auto;padding:.4rem .9rem;font-size:.78rem">Cancel</button>
            <button class="btn btn-primary" id="btnPsPrint" style="flex:none;width:auto;padding:.4rem .9rem;font-size:.78rem;margin-left:auto">\u{1F5A8} Print</button>
          </div>
        </div>`;

      document.getElementById("btnPsClose").addEventListener("click", () => { wrap.innerHTML = ""; });

      // One tap = one print dialog. On mobile, window.print() doesn't block
      // until the dialog closes, so hiding the overlay right after calling it
      // could hide the content before the print engine captured it, producing
      // a blank page. We wait for the browser's "afterprint" event instead,
      // with a timeout fallback.
      document.getElementById("btnPsPrint").addEventListener("click", () => {
        document.getElementById("printTitle").textContent = "Green Room Sign Sheet";
        document.getElementById("printContent").innerHTML = `<div>${sheetHtml(sheets[0])}</div>`;
        document.getElementById("printOverlay").classList.remove("hidden");
        let hidden = false;
        const hideOverlay = () => {
          if (hidden) return;
          hidden = true;
          document.getElementById("printOverlay").classList.add("hidden");
          window.removeEventListener("afterprint", hideOverlay);
        };
        window.addEventListener("afterprint", hideOverlay);
        setTimeout(() => window.print(), 50);
        setTimeout(hideOverlay, 5000);
      });
    }

    renderAll();
  }

  function renderExportTab() {
    const cards = [
      { id: "Call List", icon: "\u{1F4CB}" }, { id: "Valuation Sheet", icon: "\u{1F3C5}" },
      { id: "Green Room Sign", icon: "\u2B50" },
    ];
    adminContent.innerHTML = `
      ${isSuperAdmin() ? `
      <div class="card">
        <div class="card-title">Sheet Header Name</div>
        <div class="field-label" style="margin-bottom:.5rem">This name is printed as the header on every Call List, Valuation Sheet, Green Room Sign &amp; Results sheet you generate below.</div>
        <div style="display:flex;gap:.5rem">
          <input id="fPrintHeaderName" class="input" style="flex:1" placeholder="e.g. Your Madrasa / Committee Name" value="${escapeAttr(state.printHeaderName || "")}" />
          <button class="btn btn-primary" id="btnSavePrintHeader" style="width:auto;padding:.5rem .9rem">Save</button>
        </div>
      </div>` : ""}
      <div class="export-grid">
        ${cards.map((c) => `<button class="export-card" data-kind="${c.id}"><div class="ic">${c.icon}</div><div class="t">${c.id}</div><div class="s">Tap to generate</div></button>`).join("")}
      </div>
      <div id="pickWrap"></div>
      <div id="sheetWrap"></div>
      <div style="font-size:.85rem;font-weight:500;color:var(--gold-light);margin:1.25rem 0 .5rem">Sheet History</div>
      <div class="card" style="padding:.5rem .75rem"><div id="historyListWrap"></div></div>
      <button class="btn btn-primary" id="btnExportCsv" style="width:100%;margin-top:1.25rem;padding:.75rem">\u{1F4CA} Download Full Database (CSV)</button>
      <button class="btn btn-primary" id="btnExportExcel" style="width:100%;margin-top:.6rem;padding:.75rem">\u{1F4C8} Download Full Database (Excel)</button>`;

    if (isSuperAdmin()) {
      document.getElementById("btnSavePrintHeader").addEventListener("click", () => {
        state.printHeaderName = document.getElementById("fPrintHeaderName").value.trim();
        persist();
        showToast("Sheet header name saved");
      });
    }

    renderPrintHistoryList();
    document.querySelectorAll(".export-card").forEach((b) => b.addEventListener("click", () => {
      pickEventKind = b.dataset.kind;
      document.getElementById("sheetWrap").innerHTML = "";
      document.querySelectorAll(".export-card").forEach((c) => c.classList.toggle("active", c === b)); // bug fix: highlight the selected card
      const pickWrap = document.getElementById("pickWrap");

      // Valuation Sheet: Category bar + Programme bar, one programme at a
      // time \u2014 pick a category to narrow the list, pick a single
      // programme, then Generate opens that sheet straight away.
      if (pickEventKind === "Valuation Sheet") {
        let pickCategory = "";
        let pickedEventId = "";

        function renderPicker() {
          const available = state.events.filter((e) => !pickCategory || e.category === pickCategory);
          if (pickedEventId && !available.some((e) => e.id === pickedEventId)) pickedEventId = "";
          pickWrap.innerHTML = `
            <div class="card">
              <div class="muted" style="font-size:.72rem;margin-bottom:.6rem">Select a programme for "${pickEventKind}"</div>
              <div class="field-label" style="margin-bottom:.3rem">Categories</div>
              <select id="pickCategoryFilter" class="input" style="font-size:.78rem">
                <option value="">All categories...</option>
                ${state.categories.map((c) => `<option value="${escapeAttr(c)}" ${c === pickCategory ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
              </select>
              <div class="muted" style="font-size:.68rem;margin:.3rem 0 .9rem">Leave empty to include all</div>

              <div class="field-label" style="margin-bottom:.3rem">Programme</div>
              <select id="pickEventSel" class="input" style="font-size:.78rem">
                <option value="">Select a programme...</option>
                ${available.map((e) => `<option value="${e.id}" ${e.id === pickedEventId ? "selected" : ""}>${escapeHtml(e.name)} (${e.category})</option>`).join("")}
              </select>

              <button class="btn btn-primary" id="btnGenerate" style="width:100%;margin-top:.9rem">Generate</button>
            </div>`;

          document.getElementById("pickCategoryFilter").addEventListener("change", (e) => { pickCategory = e.target.value; renderPicker(); });
          document.getElementById("pickEventSel").addEventListener("change", (e) => { pickedEventId = e.target.value; });

          document.getElementById("btnGenerate").addEventListener("click", () => {
            if (!pickedEventId) return showToast("Choose a programme first");
            const sheetWrap = document.getElementById("sheetWrap");
            const event = state.events.find((e) => e.id === pickedEventId);
            event.status = "ticked";
            const parts = event.type === "Group" ? groupAwareParticipants(pickedEventId) : state.students.filter((s) => s.events.includes(pickedEventId));
            persist(); renderTicker(); renderChecklist();
            renderValuationSheetInline(sheetWrap, [{ event, eventId: pickedEventId, participants: parts }]);
            sheetWrap.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        }

        renderPicker();
        return;
      }

      // ---- Call List and Green Room Sign: single-programme search picker ----
      // Both Call List and Green Room Sign get a Category dropdown above the
      // search box to narrow the list first.
      let pickedEventId = "";
      let pickCategory = "";
      pickWrap.innerHTML = `
        <div class="card">
          <div class="muted" style="font-size:.72rem;margin-bottom:.5rem">Select programme for "${pickEventKind}"</div>
          <div class="field-label" style="margin-bottom:.3rem">Category</div>
          <select id="pickCategoryFilter" class="input" style="font-size:.78rem;margin-bottom:.6rem">
            <option value="">All categories...</option>
            ${state.categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
          <div style="position:relative">
            <input id="pickEventSearch" class="input" placeholder="Tap to search programme or category..." autocomplete="off" style="width:100%" />
            <div id="pickEventDropdown" class="autocomplete-dropdown hidden"></div>
          </div>
          <button class="btn btn-primary" id="btnGenerate" style="width:100%;margin-top:.6rem">Generate</button>
        </div>`;

      const searchInput = document.getElementById("pickEventSearch");
      const dropdown = document.getElementById("pickEventDropdown");
      function showDropdown(q) {
        const query = (q || "").trim().toLowerCase();
        const matches = state.events
          .filter((e) => !pickCategory || e.category === pickCategory)
          .filter((e) => !query || (e.name + " " + e.category).toLowerCase().includes(query));
        dropdown.innerHTML = matches.length
          ? matches.map((e) => `<div class="autocomplete-item" data-id="${e.id}" data-name="${escapeAttr(e.name)}">${escapeHtml(e.name)} <span class="muted">(${escapeHtml(e.category)})</span></div>`).join("")
          : `<div class="autocomplete-empty">No programme found</div>`;
        dropdown.classList.remove("hidden");
        dropdown.querySelectorAll(".autocomplete-item").forEach((it) => it.addEventListener("click", () => {
          pickedEventId = it.dataset.id;
          searchInput.value = it.dataset.name;
          dropdown.classList.add("hidden");
        }));
      }
      document.getElementById("pickCategoryFilter").addEventListener("change", (e) => {
        pickCategory = e.target.value; pickedEventId = ""; searchInput.value = ""; showDropdown("");
      });
      searchInput.addEventListener("focus", () => showDropdown(searchInput.value));
      searchInput.addEventListener("input", () => { pickedEventId = ""; showDropdown(searchInput.value); });
      document.addEventListener("click", (e) => {
        if (!e.target.closest("#pickEventSearch") && !e.target.closest("#pickEventDropdown")) dropdown.classList.add("hidden");
      });

      document.getElementById("btnGenerate").addEventListener("click", () => {
        const eid = pickedEventId;
        if (!eid) return showToast("Choose a programme first");
        if (pickEventKind === "Green Room Sign") {
          const event = state.events.find((e) => e.id === eid);
          event.status = "ticked"; persist(); renderTicker(); renderChecklist();
          const parts = event.type === "Group" ? groupAwareParticipants(eid) : state.students.filter((s) => s.events.includes(eid));
          const sheetWrap = document.getElementById("sheetWrap");
          renderGreenRoomSheetInline(sheetWrap, [{ event, eventId: eid, participants: parts }]);
          sheetWrap.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          openPrintSheet(pickEventKind, eid);
        }
      });
    }));
    document.getElementById("btnExportCsv").addEventListener("click", downloadCsv);
    document.getElementById("btnExportExcel").addEventListener("click", downloadExcel);
  }
  /* ---- Results tab: publish/unpublish each programme's result and preview
     it (for the announcer) before publishing. Sheet generation lives in
     Green Room only \u2014 this tab is purely about result status. ---- */
  function renderResultsTab() {
    let searchQuery = "";

    // "In Progress" = Green Room Sign already generated for this programme
    // (i.e. it's on stage / underway) but marks haven't been entered yet.
    function computeStats() {
      const stats = { Pending: 0, "In Progress": 0, Submitted: 0, Published: 0 };
      state.events.forEach((e) => {
        const status = getResultStatus(e);
        if (status === "Pending" && e.status === "ticked") stats["In Progress"]++;
        else stats[status]++;
      });
      return stats;
    }

    function getFilteredEvents() {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return state.events;
      return state.events.filter((e) => e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
    }

    function renderList() {
      const stats = computeStats();
      const statsWrap = document.getElementById("resultsStatsWrap");
      if (statsWrap) statsWrap.innerHTML = `
        <div class="results-stat-card pending"><span class="label">Pending</span><span class="num">${stats.Pending}</span></div>
        <div class="results-stat-card inprogress"><span class="label">In Progress</span><span class="num">${stats["In Progress"]}</span></div>
        <div class="results-stat-card submitted"><span class="label">Submitted</span><span class="num">${stats.Submitted}</span></div>
        <div class="results-stat-card published"><span class="label">Published</span><span class="num">${stats.Published}</span></div>`;

      const filtered = getFilteredEvents();
      const listWrap = document.getElementById("resultsCardListWrap");
      if (!listWrap) return;
      if (!filtered.length) {
        listWrap.innerHTML = `<div class="empty-note">No programmes found.</div>`;
        return;
      }
      listWrap.innerHTML = filtered.map((e, i) => {
        const status = getResultStatus(e);
        const pillClass = status === "Published" ? "status-published" : status === "Submitted" ? "status-submitted" : "status-pending";
        return `
        <div class="history-row" data-id="${e.id}">
          <div class="history-row-main">
            <div class="history-row-title"><span class="muted">#${i + 1}</span> ${escapeHtml(e.name)}</div>
            <div class="muted" style="font-size:.68rem;margin:.15rem 0 .35rem">${escapeHtml(e.category)}</div>
            <span class="status-pill ${pillClass}">${status}</span>
          </div>
          <div class="history-dots-wrap">
            <button class="history-dots-btn" data-id="${e.id}">&#8942;</button>
            <div class="history-dots-menu hidden" data-id="${e.id}">
              <button class="history-menu-item" data-action="view" data-id="${e.id}">View</button>
              ${status === "Published"
                ? `<button class="history-menu-item" data-action="unpublish" data-id="${e.id}">Unpublish</button>`
                : `<button class="history-menu-item" data-action="publish" data-id="${e.id}">Publish</button>`}
            </div>
          </div>
        </div>`;
      }).join("");

      listWrap.querySelectorAll(".history-dots-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          listWrap.querySelectorAll(".history-dots-menu").forEach((m) => { if (m.dataset.id !== btn.dataset.id) m.classList.add("hidden"); });
          listWrap.querySelector(`.history-dots-menu[data-id="${btn.dataset.id}"]`).classList.toggle("hidden");
        });
      });
      listWrap.querySelectorAll(".history-menu-item").forEach((item) => {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = item.dataset.id, action = item.dataset.action;
          listWrap.querySelectorAll(".history-dots-menu").forEach((m) => m.classList.add("hidden"));
          const ev = state.events.find((x) => x.id === id);
          if (action === "view") {
            openResultViewModal(id);
          } else if (action === "publish") {
            if (!publishEventResult(id)) { showToast("Enter at least one mark before publishing"); return; }
            renderLeaderboard(); renderResultsList(); renderTicker();
            showToast(`${ev.name} result published \u2014 now live on the home page`);
            renderList();
          } else if (action === "unpublish") {
            unpublishEventResult(id);
            renderLeaderboard(); renderResultsList(); renderTicker();
            showToast(`${ev.name} result unpublished`);
            renderList();
          }
        });
      });
    }

    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Results</div>
        <div class="muted" style="font-size:.75rem;margin-bottom:.75rem">Manage and reorder competition results, and view team points</div>
        <div class="results-stats" id="resultsStatsWrap"></div>
        <div class="results-search-wrap">
          <span class="results-search-icon">&#128269;</span>
          <input id="resultsSearchInput" class="input results-search-input" placeholder="Search results..." />
        </div>
        <div id="resultsCardListWrap"></div>
      </div>`;

    renderList();
    document.getElementById("resultsSearchInput").addEventListener("input", (e) => { searchQuery = e.target.value; renderList(); });
  }

  // Full result table for admins — shown only inside Admin -> Results -> View.
  // Guests never see this: Mark / Prize / Points are admin-only scoring detail.
  const PRIZE_LABEL = { first: "1st Prize", second: "2nd Prize", third: "3rd Prize" };
  function openResultViewModal(eventId) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event) return;
    const idx = state.events.findIndex((e) => e.id === eventId) + 1;
    const status = getResultStatus(event);
    const pillClass = status === "Published" ? "status-published" : status === "Submitted" ? "status-submitted" : "status-pending";
    const ranked = rankedParticipants(eventId).filter((r) => r.mark != null);
    const rankKeys = ["first", "second", "third"];

    const rowsHtml = ranked.length
      ? ranked.map((r, i) => {
          const team = state.teams.find((t) => t.id === r.student.team);
          const rankKey = rankKeys[i];
          const prizeHtml = rankKey ? `${RANK_ICON[rankKey]} ${PRIZE_LABEL[rankKey]}` : "-";
          const pointsHtml = rankKey ? RANK_POINTS[rankKey] : 0;
          return `<tr>
            <td>${i + 1}</td>
            <td>${r.student.chestNo || "\u2014"}</td>
            <td>${escapeHtml(resultDisplayName(event, r.student.name))}</td>
            <td>${codeLetterFor(eventId, r.student.id)}</td>
            <td>${team ? escapeHtml(team.name) : "\u2014"}</td>
            <td><b>${r.mark}</b></td>
            <td>${prizeHtml}</td>
            <td><b>${pointsHtml}</b></td>
          </tr>`;
        }).join("")
      : "";

    modalBody.innerHTML = `
      <div class="marks-modal">
        <div class="row-between" style="margin-bottom:.75rem;align-items:flex-start">
          <div>
            <div style="font-weight:700;font-size:1rem">#${idx} ${escapeHtml(event.name)}</div>
            <span class="status-pill ${pillClass}" style="margin-top:.3rem;display:inline-block">${status}</span>
          </div>
          <button class="dots-btn" id="rvClose" style="font-size:1.2rem">&times;</button>
        </div>
        ${ranked.length ? `
        <div style="overflow-x:auto">
          <table class="result-detail-table"><thead><tr>
            <th>Sl No</th><th>Chest #</th><th>Participant</th><th>Code Letter</th><th>Team</th><th>Mark</th><th>Prize</th><th>Points</th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>
        </div>` : `<div class="empty-note">No marks entered yet for this programme.</div>`}
        <div class="modal-actions" style="background:transparent;padding:.75rem 0 0;gap:.5rem">
          <button class="btn btn-ghost" id="rvClose2" style="flex:1">Close</button>
          ${ranked.length ? `<button class="btn btn-primary" id="rvPrint" style="flex:1">\u{1F5A8} Print Result</button>` : ""}
        </div>
      </div>`;
    document.getElementById("rvClose").addEventListener("click", closeTopScreen);
    document.getElementById("rvClose2").addEventListener("click", closeTopScreen);
    const printBtn = document.getElementById("rvPrint");
    if (printBtn) printBtn.addEventListener("click", () => openResultPrintSheet(idx, event, rowsHtml));
    modalOverlay.classList.remove("hidden");
    pushScreen(() => { modalOverlay.classList.add("hidden"); modalBody.innerHTML = ""; });
  }

  // Reuses the shared #printOverlay (see openScheduleSheet) to print this
  // exact admin result table on A4.
  function openResultPrintSheet(idx, event, rowsHtml) {
    const printContentHtml = `
      <div class="schedule-print-header">
        <h1>${escapeHtml(state.hero.title)}</h1>
        <h2>#${idx} ${escapeHtml(event.name).toUpperCase()} \u2014 ${escapeHtml(event.category).toUpperCase()}</h2>
      </div>
      <table class="schedule-print-table"><thead><tr>
        <th>Sl No</th><th>Chest #</th><th>Participant</th><th>Code Letter</th><th>Team</th><th>Mark</th><th>Prize</th><th>Points</th>
      </tr></thead><tbody>${rowsHtml}</tbody></table>
      <div class="schedule-print-footer">${escapeHtml(state.hero.title)} \u00a9 All rights reserved</div>`;

    document.getElementById("printTitle").textContent = "Result Sheet";
    document.getElementById("printContent").innerHTML = printContentHtml;
    document.getElementById("printOverlay").classList.remove("hidden");
    pushScreen(() => document.getElementById("printOverlay").classList.add("hidden"));
  }

  // Bug fix: status used to be a one-way "ticked" flag set the moment any
  // sheet (Call List/Green Room Sign/etc.) was generated, with nothing in the
  // app ever able to reset it \u2014 so it stayed stuck on "In Progress" even
  // after the underlying marks/results were cleared or deleted. Basing it on
  // getResultStatus() instead ties it to live data: it naturally falls back
  // to Pending if marks are removed, and only reaches Completed once results
  // are actually published, no separate reset code needed.
  function renderChecklist() {
    const wrap = document.getElementById("checklistWrap");
    if (!wrap) return; // Print/Export tab isn't the active admin tab right now
    wrap.innerHTML = state.events.map((e) => {
      const rs = getResultStatus(e);
      const label = rs === "Published" ? "\u2713 Completed" : (rs === "Submitted" || e.status === "ticked") ? "\u2713 In Progress" : "Pending";
      const cls = rs === "Published" ? "done" : (rs === "Submitted" || e.status === "ticked") ? "in-progress" : "";
      return `
      <div class="checklist-row ${cls}">
        <span>${escapeHtml(e.name)} <span class="muted">\u00b7 ${e.category}</span></span>
        ${cls ? `<span class="tick">${label}</span>` : `<span class="muted">${label}</span>`}
      </div>`;
    }).join("");
  }

  // Bug fix: stage groups used to render in whatever order they were first
  // added in (Object.keys insertion order), so "Stage 2" could appear above
  // "Stage 1" if it happened to be created first. Sort by the number inside
  // the stage name instead, so Stage 1 always comes before Stage 2, etc.
  function sortStageKeys(keys) {
    return [...keys].sort((a, b) => {
      const na = parseInt((a.match(/\d+/) || [])[0], 10);
      const nb = parseInt((b.match(/\d+/) || [])[0], 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      if (!isNaN(na) && isNaN(nb)) return -1;
      if (isNaN(na) && !isNaN(nb)) return 1;
      return a.localeCompare(b);
    });
  }

  function formatTimeRange(start, end) {
    const fmt = (t) => {
      if (!t) return "";
      const [h, m] = t.split(":").map(Number);
      const period = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
    };
    return `${fmt(start)} - ${fmt(end)}`;
  }

  /* ---- Schedule tab: build a stage-wise programme schedule from existing
     categories/programmes, then generate a printable A4 sheet. Nothing here
     is hardcoded \u2014 every stage, category, programme & time is picked by
     the admin from live data. ---- */
  function renderScheduleTab() {
    let editingId = null; // id of the schedule entry currently open for editing, if any

    const refreshEventOptions = (selectEl, categoryEl, selectedEventId) => {
      const cat = categoryEl.value;
      const evs = state.events.filter((e) => e.category === cat);
      selectEl.innerHTML = evs.length
        ? evs.map((e) => `<option value="${e.id}" ${e.id === selectedEventId ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("")
        : `<option value="">No programmes in this category</option>`;
    };

    const editFormHtml = (s) => {
      const ev = state.events.find((e) => e.id === s.eventId);
      const cat = ev ? ev.category : (state.categories[0] || "");
      return `
        <div class="card" style="padding:.7rem .85rem;margin:.4rem 0;background:var(--surface2)">
          <div class="field-label">Stage</div>
          <input id="editStage-${s.id}" class="input" value="${escapeAttr(s.stage)}" style="margin-bottom:.5rem" />
          <div class="field-label">Category</div>
          <select id="editCategory-${s.id}" class="input" style="margin-bottom:.5rem">
            ${state.categories.map((c) => `<option value="${escapeAttr(c)}" ${c === cat ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
          </select>
          <div class="field-label">Programme</div>
          <select id="editEvent-${s.id}" class="input" style="margin-bottom:.5rem"></select>
          <div style="display:flex;gap:.6rem;margin-bottom:.6rem">
            <div style="flex:1"><div class="field-label">Start Time</div><input id="editStart-${s.id}" type="time" class="input" value="${escapeAttr(s.start)}" /></div>
            <div style="flex:1"><div class="field-label">End Time</div><input id="editEnd-${s.id}" type="time" class="input" value="${escapeAttr(s.end)}" /></div>
          </div>
          <div style="display:flex;gap:.5rem">
            <button class="btn btn-primary" data-save-sched="${s.id}" style="flex:1;padding:.55rem">\u2713 Save Changes</button>
            <button class="btn btn-ghost" data-cancel-sched="${s.id}" style="flex:1;padding:.55rem">Cancel</button>
          </div>
        </div>`;
    };

    const renderList = () => {
      const wrap = document.getElementById("scheduleListWrap");
      if (!state.schedule.length) {
        wrap.innerHTML = `<div class="card" style="text-align:center;color:var(--muted);padding:1.5rem">No schedule entries yet \u2014 add one above.</div>`;
        return;
      }
      const groups = {};
      state.schedule.forEach((s) => { (groups[s.stage] = groups[s.stage] || []).push(s); });
      wrap.innerHTML = sortStageKeys(Object.keys(groups)).map((stage) => `
        <div class="card" style="padding:.7rem .85rem;margin-bottom:.6rem">
          <div style="font-weight:700;font-size:.8rem;color:var(--gold-light);margin-bottom:.4rem">${escapeHtml(stage)}</div>
          ${groups[stage].map((s) => {
            if (editingId === s.id) return editFormHtml(s);
            const ev = state.events.find((e) => e.id === s.eventId);
            return `<div class="schedule-item-row" data-open-sched="${s.id}" style="display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-top:1px solid var(--border);cursor:pointer">
              <div>
                <div style="font-size:.85rem;font-weight:600">${ev ? escapeHtml(ev.name) : "(programme deleted)"}</div>
                <div style="font-size:.72rem;color:var(--muted)">${ev ? escapeHtml(ev.category) : ""} \u00b7 ${formatTimeRange(s.start, s.end)} \u00b7 <span style="color:var(--gold-light)">Tap to edit</span></div>
              </div>
              <button class="delete-text-btn" data-del-sched="${s.id}">Delete</button>
            </div>`;
          }).join("")}
        </div>`).join("");

      wrap.querySelectorAll("[data-del-sched]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("Delete this schedule entry?")) return;
        state.schedule = state.schedule.filter((s) => s.id !== b.dataset.delSched);
        persist();
        if (editingId === b.dataset.delSched) editingId = null;
        renderList();
        showToast("Schedule entry deleted");
      }));

      // Tap anywhere on a row (outside the delete button) to open it for editing.
      wrap.querySelectorAll("[data-open-sched]").forEach((row) => row.addEventListener("click", () => {
        editingId = row.dataset.openSched;
        renderList();
      }));

      // Wire up the edit form for whichever entry is currently open.
      if (editingId) {
        const entry = state.schedule.find((s) => s.id === editingId);
        if (entry) {
          const catSel = document.getElementById(`editCategory-${entry.id}`);
          const evSel = document.getElementById(`editEvent-${entry.id}`);
          refreshEventOptions(evSel, catSel, entry.eventId);
          catSel.addEventListener("change", () => refreshEventOptions(evSel, catSel, null));

          document.querySelector(`[data-save-sched="${entry.id}"]`).addEventListener("click", () => {
            const stage = document.getElementById(`editStage-${entry.id}`).value.trim();
            const eventId = evSel.value;
            const start = document.getElementById(`editStart-${entry.id}`).value;
            const end = document.getElementById(`editEnd-${entry.id}`).value;
            if (!stage) return showToast("Enter a stage label");
            if (!eventId) return showToast("Choose a programme");
            if (!start || !end) return showToast("Choose start & end time");
            entry.stage = stage; entry.eventId = eventId; entry.start = start; entry.end = end;
            persist();
            editingId = null;
            renderList();
            showToast("Schedule entry updated");
          });
          document.querySelector(`[data-cancel-sched="${entry.id}"]`).addEventListener("click", () => {
            editingId = null;
            renderList();
          });
        }
      }
    };

    adminContent.innerHTML = `
      <div class="card">
        <div class="card-title">Add Schedule Entry</div>
        <div class="field-label">Stage (shown as the section heading)</div>
        <input id="schStage" class="input" placeholder="e.g. STAGE NO: 2 (UP CATEGORY)" style="margin-bottom:.6rem" />
        <div class="field-label">Category</div>
        <select id="schCategory" class="input" style="margin-bottom:.6rem">${state.categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("")}</select>
        <div class="field-label">Programme</div>
        <select id="schEvent" class="input" style="margin-bottom:.6rem"></select>
        <div style="display:flex;gap:.6rem;margin-bottom:.75rem">
          <div style="flex:1"><div class="field-label">Start Time</div><input id="schStart" type="time" class="input" /></div>
          <div style="flex:1"><div class="field-label">End Time</div><input id="schEnd" type="time" class="input" /></div>
        </div>
        <button class="btn btn-primary" id="btnAddSchedule" style="width:100%;padding:.65rem">+ Add to Schedule</button>
      </div>
      <div style="font-size:.85rem;font-weight:500;color:var(--gold-light);margin:1.25rem 0 .5rem">Schedule Entries</div>
      <div id="scheduleListWrap"></div>
      <button class="btn btn-primary" id="btnGenerateSchedule" style="width:100%;margin-top:1.25rem;padding:.75rem">\u{1F5A8} Print / Share Schedule (PDF)</button>`;

    refreshEventOptions(document.getElementById("schEvent"), document.getElementById("schCategory"), null);
    document.getElementById("schCategory").addEventListener("change", () => refreshEventOptions(document.getElementById("schEvent"), document.getElementById("schCategory"), null));
    renderList();

    document.getElementById("btnAddSchedule").addEventListener("click", () => {
      const eventId = document.getElementById("schEvent").value;
      const stage = document.getElementById("schStage").value.trim();
      const start = document.getElementById("schStart").value;
      const end = document.getElementById("schEnd").value;
      if (!stage) return showToast("Enter a stage label");
      if (!eventId) return showToast("Choose a programme");
      if (!start || !end) return showToast("Choose start & end time");
      state.schedule.push({ id: uid(), stage, eventId, start, end });
      persist();
      document.getElementById("schStage").value = stage; // keep stage filled for quickly adding more items to it
      document.getElementById("schStart").value = "";
      document.getElementById("schEnd").value = "";
      renderList();
      showToast("Added to schedule");
    });

    document.getElementById("btnGenerateSchedule").addEventListener("click", openScheduleSheet);
  }

  function openScheduleSheet() {
    if (!state.schedule.length) return showToast("Add at least one schedule entry first");
    const groups = {};
    state.schedule.forEach((s) => { (groups[s.stage] = groups[s.stage] || []).push(s); });

    const stageBlocksHtml = sortStageKeys(Object.keys(groups)).map((stage) => {
      const rows = groups[stage].map((s, i) => {
        const ev = state.events.find((e) => e.id === s.eventId);
        return `<tr><td>${String(i + 1).padStart(2, "0")}</td><td>${ev ? escapeHtml(ev.name) : ""}</td><td>${ev ? escapeHtml(ev.category) : ""}</td><td>${formatTimeRange(s.start, s.end)}</td></tr>`;
      }).join("");
      return `
        <div class="schedule-stage-block">
          <div class="schedule-stage-header">${escapeHtml(stage)}</div>
          <table class="schedule-print-table">
            <thead><tr><th>SL NO</th><th>ITEM NAME</th><th>CATEGORY</th><th>TIME</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join("");

    const printContentHtml = `
      <div class="schedule-print-header">
        <h1>${escapeHtml(state.hero.title)}</h1>
        <h2>PROGRAM SCHEDULE</h2>
      </div>
      ${stageBlocksHtml}
      <div class="schedule-print-footer">${escapeHtml(state.hero.title)} \u00a9 All rights reserved</div>`;

    document.getElementById("printTitle").textContent = "Program Schedule";
    document.getElementById("printContent").innerHTML = printContentHtml;
    document.getElementById("printOverlay").classList.remove("hidden");
    pushScreen(() => document.getElementById("printOverlay").classList.add("hidden"));
  }

  function openPrintSheet(kind, eventId, skipHistoryLog) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event) {
      // Programme was deleted after this sheet/history entry was created \u2014
      // bail out cleanly instead of crashing the whole Green Room screen.
      showToast("That programme no longer exists");
      return;
    }
    event.status = "ticked";
    persist(); renderTicker(); renderChecklist();

    // Full roster for this programme — used everywhere except the Group
    // Green Room Sign, which only needs one leader's signature per team.
    // (Call List, Valuation Sheet & Results were previously all sharing the
    // leaders-only list too, which silently dropped every non-leader team
    // member from those sheets for Group programmes.)
    const allParticipants = state.students.filter((s) => s.events.includes(eventId));
    const participants = (kind === "Green Room Sign" && event.type === "Group")
      ? groupAwareParticipants(eventId) : allParticipants;
    const now = new Date();
    const timestamp = now.toLocaleDateString("en-GB") + " " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const sectorLine = escapeHtml(state.printHeaderName || state.hero.title);
    let body;

    if (kind === "Green Room Sign" && event.type === "Group") {
      body = `
        <div class="print-section-row"><b>${escapeHtml(event.name.toUpperCase())}</b><span>${event.type}</span><b>${event.category.toUpperCase()}</b></div>
        <table><thead><tr><th>Chest No</th><th>Team</th><th>Leader Name</th><th>Code Letter</th><th>Leader Signature</th></tr></thead><tbody>
          ${participants.map((s) => {
            const team = state.teams.find((t) => t.id === s.team);
            return `<tr><td>${s.chestNo}</td><td>${team ? escapeHtml(team.name) : ""}</td><td>${escapeHtml(s.name)}</td><td>&nbsp;</td><td>&nbsp;</td></tr>`;
          }).join("")}
          <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
        </tbody></table>
        <div style="margin-top:1.25rem;font-size:.78rem">
          <div style="margin-bottom:.4rem">Competition Start Time: ______________</div>
          <div style="margin-bottom:1.5rem">Competition End Time: ______________</div>
          <div style="text-align:center;font-size:.75rem;color:#444">Stage incharge's Name and Signature</div>
        </div>`;
    } else if (kind === "Green Room Sign") {
      body = `
        <div class="print-section-row"><b>${escapeHtml(event.name.toUpperCase())}</b><span>${event.type}</span><b>${event.category.toUpperCase()}</b></div>
        <table><thead><tr><th>Chest No</th><th>Participant</th><th>Code Letter</th><th>Participants Signature</th></tr></thead><tbody>
          ${participants.map((s) => `<tr><td>${s.chestNo}</td><td>${escapeHtml(s.name)}</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join("")}
          <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
        </tbody></table>
        <div style="margin-top:1.25rem;font-size:.78rem">
          <div style="margin-bottom:.4rem">Competition Start Time: ______________</div>
          <div style="margin-bottom:1.5rem">Competition End Time: ______________</div>
          <div>Green Room Coordinator Signature: ______________</div>
        </div>`;
    } else if (kind === "Valuation Sheet") {
      body = `
        <div class="print-section-row"><b>${escapeHtml(event.name.toUpperCase())}</b><b>${event.category.toUpperCase()}</b><span>${event.type}</span></div>
        <div style="text-align:right;font-size:.7rem;color:#666;margin-bottom:.4rem">Stage No: ______</div>
        <table><thead>
          <tr><th rowspan="2">Chest No</th><th rowspan="2">Participant</th><th rowspan="2">Code Letter</th><th colspan="3">Judge</th></tr>
          <tr><th>&nbsp;</th><th>&nbsp;</th><th>&nbsp;</th></tr>
        </thead><tbody>
          ${participants.map((s) => `<tr><td>${s.chestNo}</td><td>${escapeHtml(s.name)}</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join("")}
        </tbody></table>
        <div style="margin-top:1.25rem;font-size:.78rem">
          <div>Judge's Name and Signature :</div>
          <div style="margin-top:1rem">Judging Comments:</div>
        </div>`;
    } else if (kind === "Results") {
      const ranked = rankedParticipants(eventId).filter((r) => r.mark != null);
      const legacy = ["first", "second", "third"].map((rank) => {
        const entry = state.results[eventId] && state.results[eventId][rank];
        const st = entry ? state.students.find((s) => s.id === entry.studentId) : null;
        return st ? { student: st, mark: null } : null;
      }).filter(Boolean);
      const list = ranked.length ? ranked : legacy;
      body = `
        <div class="print-section-row"><b>${escapeHtml(event.name.toUpperCase())}</b><span>${event.type} \u2013 ${event.gender}</span><b>${event.category.toUpperCase()}</b></div>
        <table><thead><tr><th>Standing</th><th>Chest No</th><th>Candidate Name</th><th>Team</th><th>Mark</th><th>Points</th></tr></thead><tbody>
          ${list.map((r, i) => {
            const team = state.teams.find((t) => t.id === r.student.team);
            const points = i === 0 ? RANK_POINTS.first : i === 1 ? RANK_POINTS.second : i === 2 ? RANK_POINTS.third : null;
            return `<tr><td>${ORDINAL(i + 1)}</td><td>${r.student.chestNo}</td><td>${escapeHtml(resultDisplayName(event, r.student.name))}</td><td>${team ? escapeHtml(team.name) : ""}</td><td>${r.mark ?? "-"}</td><td>${points ?? "-"}</td></tr>`;
          }).join("") || `<tr><td colspan="6" style="text-align:center;color:#999">No entries recorded yet.</td></tr>`}
        </tbody></table>
        <div class="print-footnote">Total entries: ${list.length}</div>`;
    } else {
      body = `
        <div class="print-section-row"><b>${escapeHtml(event.name.toUpperCase())}</b><b>${event.category.toUpperCase()}</b><span>${event.type}</span></div>
        <table><thead><tr><th>Sl. No</th><th>Chest No</th><th>Participant</th><th>Team Name</th></tr></thead><tbody>
          ${participants.map((s, i) => {
            const team = state.teams.find((t) => t.id === s.team);
            return `<tr><td>${i + 1}</td><td>${s.chestNo}</td><td>${escapeHtml(s.name)}</td><td>${team ? escapeHtml(team.name) : ""}</td></tr>`;
          }).join("")}
        </tbody></table>
        <div class="print-footnote">Total participants: ${participants.length}</div>`;
    }

    const printTitleText = `${kind} \u2014 ${event.name}`;
    const printContentHtml = `
      <div class="print-masthead"><b>${sectorLine}</b><span>${timestamp}</span></div>
      <div class="print-heading">${kind}</div>
      <hr class="print-hr" />
      ${body}`;
    document.getElementById("printTitle").textContent = printTitleText;
    document.getElementById("printContent").innerHTML = printContentHtml;
    document.getElementById("printOverlay").classList.remove("hidden");
    pushScreen(() => document.getElementById("printOverlay").classList.add("hidden"));
    showToast(`${kind} generated \u2014 programme marked in progress`);

    // Save only a lightweight pointer to history — kind + eventId. No HTML/PDF/image
    // snapshot is ever stored, so this adds almost nothing to the Firebase database.
    if (skipHistoryLog) return;
    state.printHistory.unshift({
      id: uid(), kind, eventId, eventName: event.name, category: event.category,
      title: printTitleText, savedAt: Date.now(),
    });
    if (state.printHistory.length > 200) state.printHistory.length = 200; // keep it bounded
    persist();
    if (document.getElementById("historyListWrap")) renderPrintHistoryList();
  }

  function reopenPrintHistoryEntry(entryId) {
    const entry = state.printHistory.find((h) => h.id === entryId);
    if (!entry) return false;
    // Regenerated fresh from live data (not a stored snapshot) so it always reflects
    // current marks/teams, and nothing large is ever kept in the database.
    const stillExists = state.events.some((e) => e.id === entry.eventId);
    openPrintSheet(entry.kind, entry.eventId, true);
    return stillExists;
  }

  function deletePrintHistoryEntry(entryId) {
    state.printHistory = state.printHistory.filter((h) => h.id !== entryId);
    persist();
    renderPrintHistoryList();
  }

  function renderPrintHistoryList() {
    const wrap = document.getElementById("historyListWrap");
    if (!wrap) return;
    if (!state.printHistory.length) {
      wrap.innerHTML = `<div class="muted" style="font-size:.78rem;padding:.5rem 0">No sheets generated yet.</div>`;
      return;
    }
    wrap.innerHTML = state.printHistory.map((h) => {
      const d = new Date(h.savedAt);
      const when = d.toLocaleDateString("en-GB") + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `
      <div class="history-row" data-id="${h.id}">
        <div class="history-row-main">
          <div class="history-row-title">${escapeHtml(h.kind)} \u2014 ${escapeHtml(h.eventName)}</div>
          <div class="muted" style="font-size:.68rem">${escapeHtml(h.category)} \u00b7 ${when}</div>
        </div>
        <div class="history-dots-wrap">
          <button class="history-dots-btn" data-id="${h.id}">&#8942;</button>
          <div class="history-dots-menu hidden" data-id="${h.id}">
            <button class="history-menu-item" data-action="open" data-id="${h.id}">&#128065; Re-open</button>
            <button class="history-menu-item" data-action="download" data-id="${h.id}">&#11015; Re-download</button>
            <button class="history-menu-item danger" data-action="delete" data-id="${h.id}">&#128465; Delete</button>
          </div>
        </div>
      </div>`;
    }).join("");

    document.querySelectorAll(".history-dots-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".history-dots-menu").forEach((m) => {
          if (m.dataset.id !== btn.dataset.id) m.classList.add("hidden");
        });
        wrap.querySelector(`.history-dots-menu[data-id="${btn.dataset.id}"]`).classList.toggle("hidden");
      });
    });
    document.querySelectorAll(".history-menu-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = item.dataset.id;
        if (item.dataset.action === "open") reopenPrintHistoryEntry(id);
        else if (item.dataset.action === "download") {
          if (reopenPrintHistoryEntry(id)) setTimeout(() => window.print(), 200);
        }
        else if (confirm("Delete this saved sheet from history?")) deletePrintHistoryEntry(id);
        document.querySelectorAll(".history-dots-menu").forEach((m) => m.classList.add("hidden"));
      });
    });
  }
  // Registered once (not inside renderPrintHistoryList) so re-rendering the
  // history list repeatedly never piles up extra listeners.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".history-dots-wrap")) {
      document.querySelectorAll(".history-dots-menu").forEach((m) => m.classList.add("hidden"));
    }
  });
  document.getElementById("btnPrintNow").addEventListener("click", () => window.print());
  document.getElementById("btnPrintClose").addEventListener("click", closeTopScreen);

  // Full database export as a real multi-sheet .xlsx (via SheetJS, loaded in
  // index.html). Complements downloadCsv() above, which is students-only.
  function downloadExcel() {
    if (typeof XLSX === "undefined") return showToast("Excel library failed to load \u2014 check your connection and try again");
    const wb = XLSX.utils.book_new();
    const teamName = (id) => state.teams.find((t) => t.id === id)?.name || "";
    const eventName = (id) => state.events.find((e) => e.id === id)?.name || "";
    const studentById = (id) => state.students.find((s) => s.id === id);

    // Teams
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.teams.map((t) => ({
      "Team Name": t.name, Leader: t.leader || "", Assistant: t.assistant || "", Color: t.color || "",
    }))), "Teams");

    // Students
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.students.map((s) => ({
      "Chest No": s.chestNo, Name: s.name, Class: s.cls, Phone: s.phone, Gender: s.gender,
      Category: s.category, Team: teamName(s.team),
      Programmes: (s.events || []).map(eventName).filter(Boolean).join("; "),
    }))), "Students");

    // Programmes
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.events.map((e) => ({
      Programme: e.name, Category: e.category, Type: e.type, Gender: e.gender,
      "Stage Type": e.stageType || "", "Result Status": e.resultStatus,
      Judges: (e.assignedJudges || []).join("; "),
    }))), "Programmes");

    // Marks — one row per judge mark, plus the computed final mark
    const markRows = [];
    Object.keys(state.marks).forEach((eventId) => {
      Object.keys(state.marks[eventId]).forEach((studentId) => {
        const student = studentById(studentId);
        const finalMark = finalMarkFor(eventId, studentId);
        Object.entries(state.marks[eventId][studentId]).forEach(([judge, mark]) => {
          markRows.push({
            Programme: eventName(eventId), "Chest No": student?.chestNo || "", Student: student?.name || "",
            Judge: judge, Mark: mark, "Final Mark": finalMark,
          });
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(markRows), "Marks");

    // Results — published rank winners per programme
    const resultRows = [];
    Object.entries(state.results).forEach(([eventId, r]) => {
      const ev = state.events.find((e) => e.id === eventId);
      ["first", "second", "third"].forEach((rankKey, i) => {
        const win = r && r[rankKey];
        if (!win) return;
        const student = studentById(win.studentId);
        resultRows.push({
          Programme: eventName(eventId), Rank: i + 1, "Chest No": student?.chestNo || "",
          Student: student ? resultDisplayName(ev, student.name) : "", Team: teamName(student?.team),
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultRows), "Results");

    XLSX.writeFile(wb, "meeladfest-full-database.xlsx");
    showToast("Full database exported as Excel");
  }

  function downloadCsv() {
    const rows = [["Chest No", "Name", "Class", "Phone", "Gender", "Category", "Team", "Programmes", "Rank Won"]];
    state.students.forEach((s) => {
      const team = state.teams.find((t) => t.id === s.team);
      const wonRanks = Object.entries(state.results)
        .filter(([, r]) => ["first", "second", "third"].some((k) => r && r[k] && r[k].studentId === s.id))
        .map(([eid, r]) => {
          const rank = ["first", "second", "third"].find((k) => r[k] && r[k].studentId === s.id);
          const ev = state.events.find((e) => e.id === eid);
          return `${ev ? ev.name : eid}:${rank}`;
        }).join("; ");
      rows.push([
        s.chestNo, s.name, s.cls, s.phone, s.gender, s.category, team ? team.name : "",
        s.events.map((id) => state.events.find((e) => e.id === id)?.name).filter(Boolean).join("; "),
        wonRanks,
      ]);
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    downloadDataUrl(URL.createObjectURL(blob), "meeladfest-full-backup.csv");
    showToast("Full database exported as CSV");
  }

  /* ---------------- utils ---------------- */
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(str) { return escapeHtml(str); }

  /* ---------------- init ---------------- */
  const saveFailBannerEl = document.getElementById("saveFailBanner");
  if (saveFailBannerEl) saveFailBannerEl.addEventListener("click", () => { persist(); });

  function renderAll() {
    renderTicker(); renderHero(); renderCounters(); renderLeaderboard(); renderFilters(); renderResultsList(); renderGallery();
  }

  if (dataRef) {
    dataRef.on(
      "value",
      (snapshot) => {
        if (suppressNextPersist) { suppressNextPersist = false; return; }
        const remote = snapshot.val();
        if (remote) {
          state = remote;
          ensureStateDefaults();
        } else {
          // The database read back empty. This does NOT automatically re-seed
          // Firebase anymore \u2014 that used to call persist() here, which
          // meant ANY empty/null read (a genuine first-ever load, but also a
          // transient glitch, a wrong path, timing issue, etc.) would
          // silently overwrite the real database with fresh local seed data,
          // permanently destroying whatever was actually saved. Now it only
          // shows local starter data for THIS view and puts up a banner;
          // nothing is written to Firebase until an admin explicitly saves
          // something, and even then only that one real change is written
          // (not a full blind reseed).
          console.warn("Firebase read back empty at 'festData' \u2014 not auto-saving. If you expected existing data, do not make changes yet; check the Firebase Console Data tab first.");
          const banner = document.getElementById("saveFailBanner");
          if (banner) {
            banner.textContent = "\u26A0 No saved data found on the server \u2014 showing local starter data. If you expected your existing data, do NOT save yet \u2014 check Firebase Console first.";
            banner.classList.remove("hidden");
          }
        }
        firebaseReady = true;
        renderAll();
      },
      (err) => {
        console.error("Firebase read failed, using local data only:", err);
        renderAll();
      }
    );
  } else {
    renderAll();
  }
})();
