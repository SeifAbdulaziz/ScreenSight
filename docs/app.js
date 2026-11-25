(() => {
  const REPO = "SeifAbdulaziz/ScreenSight";
  const RELEASE_FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;
  const CACHE_KEY_REPO = "screensight_repo_meta_v1";
  const CACHE_KEY_RELEASE = "screensight_release_meta_v1";
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // ---------------------------------------------------------------------------
  // 1. Mobile Navigation Drawer
  // ---------------------------------------------------------------------------
  const menuToggle = document.getElementById("mobile-menu-toggle");
  const mobileNav = document.getElementById("mobile-nav");
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener("click", () => {
      const next = mobileNav.hasAttribute("hidden");
      if (next) {
        mobileNav.removeAttribute("hidden");
      } else {
        mobileNav.setAttribute("hidden", "");
      }
      menuToggle.setAttribute("aria-expanded", String(next));
    });

    mobileNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        mobileNav.setAttribute("hidden", "");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 2. GitHub Repo Stars & Dynamic Latest Release Downloader
  // ---------------------------------------------------------------------------
  function readCache(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  function writeCache(key, data) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
    } catch {
      // Ignore storage quota errors cleanly
    }
  }

  async function fetchCachedJson(url, cacheKey) {
    const cached = readCache(cacheKey);
    if (cached) return cached;
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const json = await res.json();
    writeCache(cacheKey, json);
    return json;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
  }

  function formatStars(count) {
    if (!Number.isFinite(count)) return "—";
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
  }

  async function hydrateGitHubData() {
    const starCountEl = document.getElementById("github-star-count");
    try {
      const repo = await fetchCachedJson(
        `https://api.github.com/repos/${REPO}`,
        CACHE_KEY_REPO
      );
      if (starCountEl && typeof repo.stargazers_count === "number") {
        starCountEl.textContent = formatStars(repo.stargazers_count);
      }
    } catch {
      if (starCountEl) starCountEl.textContent = "Star";
    }

    const heroBtn = document.getElementById("hero-download-btn");
    const heroText = document.getElementById("hero-download-text");
    const navBtn = document.getElementById("nav-download-btn");
    const heroTag = document.getElementById("hero-release-tag");
    const heroMsi = document.getElementById("hero-msi-link");
    const heroExe = document.getElementById("hero-exe-link");
    const qsVersionBadge = document.getElementById("qs-version-badge");
    const qsMsiBtn = document.getElementById("qs-msi-btn");
    const qsMsiLabel = document.getElementById("qs-msi-label");
    const qsExeBtn = document.getElementById("qs-exe-btn");
    const qsExeLabel = document.getElementById("qs-exe-label");

    try {
      const release = await fetchCachedJson(
        `https://api.github.com/repos/${REPO}/releases/latest`,
        CACHE_KEY_RELEASE
      );
      const tag = release.tag_name || "Latest";
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const msiAsset = assets.find((a) => /\.msi$/i.test(a.name));
      const exeAsset = assets.find((a) => /-setup\.exe$|\.exe$/i.test(a.name));
      const primaryAsset = msiAsset || exeAsset;

      if (navBtn) {
        navBtn.textContent = `Download ${tag}`;
      }

      if (heroTag) {
        heroTag.textContent = `${tag} · Windows x64`;
      }

      if (qsVersionBadge) {
        qsVersionBadge.textContent = `${tag} · Windows x64`;
      }

      if (primaryAsset && heroBtn && heroText) {
        const sizeStr = formatBytes(primaryAsset.size);
        const ext = /\.msi$/i.test(primaryAsset.name) ? ".msi" : ".exe";
        heroBtn.href = primaryAsset.browser_download_url;
        heroText.textContent = sizeStr
          ? `Download ${tag} (${ext} · ${sizeStr})`
          : `Download ${tag} (${ext})`;
      } else if (heroBtn && release.html_url) {
        heroBtn.href = release.html_url;
        if (heroText) heroText.textContent = `Download ${tag}`;
      }

      if (msiAsset) {
        const sz = formatBytes(msiAsset.size);
        if (heroMsi) {
          heroMsi.href = msiAsset.browser_download_url;
          heroMsi.textContent = sz ? `.msi Installer (${sz})` : ".msi Installer";
        }
        if (qsMsiBtn && qsMsiLabel) {
          qsMsiBtn.href = msiAsset.browser_download_url;
          qsMsiLabel.textContent = sz
            ? `Download .msi ${tag} (${sz})`
            : `Download .msi ${tag}`;
        }
      }

      if (exeAsset) {
        const sz = formatBytes(exeAsset.size);
        if (heroExe) {
          heroExe.href = exeAsset.browser_download_url;
          heroExe.textContent = sz ? `-setup.exe (${sz})` : "NSIS -setup.exe";
        }
        if (qsExeBtn && qsExeLabel) {
          qsExeBtn.href = exeAsset.browser_download_url;
          qsExeLabel.textContent = sz
            ? `Download -setup.exe ${tag} (${sz})`
            : `Download -setup.exe ${tag}`;
        }
      }
    } catch {
      if (heroBtn) heroBtn.href = RELEASE_FALLBACK_URL;
      if (heroText) heroText.textContent = "Download Latest Release";
      if (heroTag) heroTag.textContent = "Latest on GitHub Releases";
      if (qsMsiBtn) qsMsiBtn.href = RELEASE_FALLBACK_URL;
      if (qsExeBtn) qsExeBtn.href = RELEASE_FALLBACK_URL;
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Hero Interactive Desk Gaze Simulator
  // ---------------------------------------------------------------------------
  const heroScreens = Array.from(document.querySelectorAll(".hero-screen"));
  const beamCone = document.getElementById("hero-beam-cone");
  const beamRay = document.getElementById("hero-beam-ray");
  const beamDot = document.getElementById("hero-beam-dot");
  const heroPoseReadout = document.getElementById("hero-pose-readout");
  let heroAutoTimer = null;
  let heroFocusedIdx = 0;

  function focusHeroScreen(idx, stopAuto) {
    if (stopAuto && heroAutoTimer) {
      clearInterval(heroAutoTimer);
      heroAutoTimer = null;
    }
    heroFocusedIdx = idx;
    heroScreens.forEach((btn, i) => {
      btn.classList.toggle("is-focused", i === idx);
      if (i === idx) {
        const rayX = btn.dataset.rayX || "280";
        const cone = btn.dataset.cone || "280,236 205,136 355,136";
        const yaw = btn.dataset.yaw || "0.0";
        const pitch = btn.dataset.pitch || "0.0";
        if (beamCone) beamCone.setAttribute("points", cone);
        if (beamRay) beamRay.setAttribute("x2", rayX);
        if (beamDot) beamDot.setAttribute("cx", rayX);
        if (heroPoseReadout) {
          heroPoseReadout.textContent = `Media Foundation · Yaw ${yaw}° · Pitch ${pitch}° → Display ${i + 1}`;
        }
      }
    });
  }

  heroScreens.forEach((btn, idx) => {
    btn.addEventListener("mouseenter", () => focusHeroScreen(idx, true));
    btn.addEventListener("click", () => focusHeroScreen(idx, true));
  });

  if (
    heroScreens.length > 0 &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    heroAutoTimer = setInterval(() => {
      focusHeroScreen((heroFocusedIdx + 1) % heroScreens.length, false);
    }, 2800);
  }

  // ---------------------------------------------------------------------------
  // 4. Inside ScreenSight Interactive Dashboard Replica
  // ---------------------------------------------------------------------------
  const HOTSPOTS = {
    displays: {
      title: "Active Displays",
      descHtml:
        "Supports N displays across landscape, portrait, ultrawide, and 2×2 stacked setups. Read-only Windows desktop coordinates (<code>osRect</code>) remain decoupled from your editable virtual desk layout (<code>deskPos</code>) inside Arrange mode.",
      specs: ["EnumDisplayMonitors", "osRect vs deskPos", "Magnetic Snap Drag"],
    },
    pose: {
      title: "Head Pose (YuNet + FSANet)",
      descHtml:
        "Local two-stage CPU ONNX pipeline filters face bounds with EMA smoothing before FSANet estimates stabilized <code>(yaw, pitch)</code> angles, switching cleanly between 1D Yaw Zones and a Weighted 2D Gaze Pad with hysteresis margin.",
      specs: ["YuNet + FSANet ONNX", "Per-Monitor (yaw, pitch)", "Hysteresis Margin"],
    },
    settings: {
      title: "Tracking Settings",
      descHtml:
        "Pick any physical Windows Media Foundation webcam, configure polling cadence (<code>10 / 15 / 24 / 30 FPS</code>, default <code>15 FPS</code>), and tune Switch Margin (4°–12°) and wall-clock <code>Instant</code> Dwell Delay.",
      specs: ["Media Foundation", "10 / 15 / 24 / 30 FPS", "Instant Dwell Timer"],
    },
    safeguards: {
      title: "Smart Safeguards",
      descHtml:
        "Watches Windows Registry <code>ConsentStore</code> to auto-yield during Zoom or Meet calls, pauses during fullscreen games (<code>SHQueryUserNotificationState</code>), filters <code>DWMWA_CLOAKED</code> windows, and switches focus via <code>AttachThreadInput</code>.",
      specs: ["ConsentStore Auto-Yield", "SHQueryUserNotificationState", "AttachThreadInput + Cloaking"],
    },
  };

  const TOPOLOGIES = {
    "2x1": {
      label: "1D Yaw Zone",
      is2D: false,
      monitors: [
        { name: "Dell U2720Q", app: "VS Code", yaw: -16, pitch: 0, padX: 28, padY: 50 },
        { name: "LG 27GL850", app: "Chrome Docs", yaw: 16, pitch: 0, padX: 72, padY: 50 },
      ],
    },
    "1over2": {
      label: "2D Gaze Pad",
      is2D: true,
      monitors: [
        { name: 'Samsung 34" Top', app: "Spotify / Docs", yaw: 0, pitch: 12, padX: 50, padY: 22, span2: true },
        { name: "Dell Left", app: "VS Code", yaw: -15, pitch: -8, padX: 28, padY: 74 },
        { name: "LG Right", app: "Windows Terminal", yaw: 15, pitch: -8, padX: 72, padY: 74 },
      ],
    },
    "2x2": {
      label: "2D Gaze Pad",
      is2D: true,
      monitors: [
        { name: "Top-Left", app: "Discord", yaw: -16, pitch: 11, padX: 28, padY: 26 },
        { name: "Top-Right", app: "Chrome", yaw: 16, pitch: 11, padX: 72, padY: 26 },
        { name: "Bottom-Left", app: "VS Code", yaw: -16, pitch: -10, padX: 28, padY: 74 },
        { name: "Bottom-Right", app: "Terminal", yaw: 16, pitch: -10, padX: 72, padY: 74 },
      ],
    },
  };

  const simState = {
    hotspot: "displays",
    topo: "2x1",
    focusedMonitor: 0,
    arrangeMode: false,
    identifyFlash: false,
    trackingEnabled: true,
    yieldActive: false,
    fullscreenActive: false,
    fps: 15,
    marginDeg: 7,
    dwellMs: 220,
    tourTimer: null,
  };

  const appShell = document.getElementById("dashboard");
  const hotspotTabs = Array.from(document.querySelectorAll(".hotspot-tab"));
  const hotspotTitle = document.getElementById("hotspot-title");
  const hotspotDesc = document.getElementById("hotspot-desc");
  const hotspotSpecs = document.getElementById("hotspot-specs");
  const displaysCanvas = document.getElementById("sim-displays-canvas");
  const layoutMeta = document.getElementById("sim-layout-meta");
  const coordTag = document.getElementById("sim-coord-tag");
  const poseModeBadge = document.getElementById("sim-pose-mode-badge");
  const yawVal = document.getElementById("sim-yaw-val");
  const pitchVal = document.getElementById("sim-pitch-val");
  const targetVal = document.getElementById("sim-target-val");
  const yawView = document.getElementById("sim-yaw-view");
  const yawTrack = document.getElementById("sim-yaw-track");
  const yawReticle = document.getElementById("sim-yaw-reticle");
  const marginBand = document.getElementById("sim-margin-band");
  const padView = document.getElementById("sim-2d-view");
  const padAnchors = document.getElementById("sim-pad-anchors");
  const padReticle = document.getElementById("sim-pad-reticle");
  const calFeedback = document.getElementById("sim-cal-feedback");
  const fpsChip = document.getElementById("sim-fps-chip");
  const settingsFpsBadge = document.getElementById("sim-settings-fps-badge");
  const statusPill = document.getElementById("sim-status-pill");
  const statusText = document.getElementById("sim-status-text");
  const footerDot = document.getElementById("sim-footer-dot");
  const footerStatus = document.getElementById("sim-footer-status");

  function setHotspot(key) {
    const info = HOTSPOTS[key];
    if (!info) return;
    simState.hotspot = key;
    if (appShell) appShell.dataset.focusedPanel = key;

    hotspotTabs.forEach((t) => {
      const active = t.dataset.hotspot === key;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
    });

    if (hotspotTitle) hotspotTitle.textContent = info.title;
    if (hotspotDesc) hotspotDesc.innerHTML = info.descHtml;
    if (hotspotSpecs) {
      hotspotSpecs.innerHTML = info.specs.map((s) => `<li>${s}</li>`).join("");
    }
  }

  function renderStatus() {
    if (!statusPill || !statusText || !footerStatus || !footerDot) return;
    statusPill.classList.remove("is-yielded", "is-paused", "is-manual");

    if (!simState.trackingEnabled) {
      statusPill.classList.add("is-manual");
      statusText.textContent = "Paused";
      footerStatus.textContent = "Manually Paused (Tray Ready)";
      footerDot.style.background = "#71717a";
    } else if (simState.yieldActive) {
      statusPill.classList.add("is-yielded");
      statusText.textContent = "Yielded to Zoom.exe";
      footerStatus.textContent = "Camera yielded to Zoom.exe";
      footerDot.style.background = "#fbbf24";
    } else if (simState.fullscreenActive) {
      statusPill.classList.add("is-paused");
      statusText.textContent = "Fullscreen Paused";
      footerStatus.textContent = "Fullscreen auto-pause active";
      footerDot.style.background = "#60a5fa";
    } else {
      statusText.textContent = "Tracking Active";
      footerStatus.textContent = "Running in System Tray";
      footerDot.style.background = "#34d399";
    }
  }

  function renderDashboard() {
    const topo = TOPOLOGIES[simState.topo];
    if (!topo) return;
    if (simState.focusedMonitor >= topo.monitors.length) {
      simState.focusedMonitor = 0;
    }

    // 1. Render Active Displays grid cleanly
    if (displaysCanvas) {
      displaysCanvas.dataset.topo = simState.topo;
      displaysCanvas.innerHTML = topo.monitors
        .map((m, idx) => {
          const focused = idx === simState.focusedMonitor;
          const spanCls = m.span2 ? " is-span-2" : "";
          const focusCls = focused ? " is-focused" : "";
          const identifyMarkup = simState.identifyFlash
            ? `<span class="identify-badge">${idx + 1}</span>`
            : "";
          return `
            <button type="button" class="sim-monitor${spanCls}${focusCls}" data-sim-mon="${idx}">
              <div class="sim-monitor-top">
                <span>${idx + 1} · ${m.name}</span>
                <span class="font-mono text-em">${m.yaw >= 0 ? "+" : ""}${m.yaw}°</span>
              </div>
              <div class="sim-monitor-sub font-mono">
                <span>${m.app}</span>
                <span>${focused ? "ACTIVE FOCUS" : simState.arrangeMode ? "deskPos editable" : "osRect synced"}</span>
              </div>
              ${identifyMarkup}
            </button>
          `;
        })
        .join("");

      displaysCanvas.querySelectorAll("[data-sim-mon]").forEach((btn) => {
        btn.addEventListener("click", () => {
          stopTour();
          simState.focusedMonitor = Number(btn.dataset.simMon);
          setHotspot("displays");
          renderDashboard();
        });
      });
    }

    if (poseModeBadge) poseModeBadge.textContent = topo.label;
    if (coordTag) {
      coordTag.textContent = simState.arrangeMode ? "Arrange: editing deskPos" : "osRect ≡ deskPos";
    }
    if (layoutMeta) {
      const modeDesc = simState.arrangeMode
        ? "Drag-snap deskPos virtual arrangement active"
        : `Click any monitor to glance · Mode: ${topo.label}`;
      layoutMeta.firstElementChild.textContent = modeDesc;
    }

    // 2. Render Head Pose (1D Yaw Zone vs 2D Gaze Pad)
    const activeMon = topo.monitors[simState.focusedMonitor];
    if (yawVal) yawVal.textContent = `${activeMon.yaw >= 0 ? "+" : ""}${activeMon.yaw.toFixed(1)}°`;
    if (pitchVal) pitchVal.textContent = `${activeMon.pitch >= 0 ? "+" : ""}${activeMon.pitch.toFixed(1)}°`;
    if (targetVal) targetVal.textContent = `Display ${simState.focusedMonitor + 1}`;

    if (yawView && padView) {
      if (topo.is2D) {
        yawView.setAttribute("hidden", "");
        padView.removeAttribute("hidden");
        if (padAnchors) {
          padAnchors.innerHTML = topo.monitors
            .map(
              (m, idx) =>
                `<span class="pad-anchor ${idx === simState.focusedMonitor ? "is-focused" : ""}" style="left:${m.padX}%;top:${m.padY}%">D${idx + 1}</span>`
            )
            .join("");
        }
        if (padReticle) {
          padReticle.style.left = `${activeMon.padX}%`;
          padReticle.style.top = `${activeMon.padY}%`;
        }
      } else {
        padView.setAttribute("hidden", "");
        yawView.removeAttribute("hidden");
        if (yawTrack) {
          const segs = yawTrack.querySelectorAll(".yaw-zone-seg");
          segs.forEach((s, i) => s.classList.toggle("is-focused", i === simState.focusedMonitor));
        }
        if (yawReticle) {
          const pct = Math.max(10, Math.min(90, 50 + activeMon.yaw * 1.35));
          yawReticle.style.left = `${pct}%`;
        }
        if (marginBand) {
          marginBand.style.width = `${simState.marginDeg * 2.2}%`;
        }
      }
    }

    if (calFeedback) {
      calFeedback.textContent = `EMA α=0.35 · Hysteresis ±${simState.marginDeg}° · Dwell ${simState.dwellMs} ms`;
    }
    if (fpsChip) {
      fpsChip.textContent = `${simState.fps} / ${simState.fps} FPS · Media Foundation`;
    }
    if (settingsFpsBadge) {
      settingsFpsBadge.textContent = `${simState.fps} FPS`;
    }

    renderStatus();
  }

  // Event bindings for dashboard controls
  hotspotTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      stopTour();
      setHotspot(tab.dataset.hotspot);
    });
  });

  document.querySelectorAll("[data-topo]").forEach((btn) => {
    if (!btn.classList.contains("mini-btn")) return;
    btn.addEventListener("click", () => {
      stopTour();
      simState.topo = btn.dataset.topo;
      document
        .querySelectorAll(".topo-pills .mini-btn")
        .forEach((b) => b.classList.toggle("is-selected", b === btn));
      setHotspot("displays");
      renderDashboard();
    });
  });

  const arrangeBtn = document.getElementById("sim-arrange-btn");
  if (arrangeBtn) {
    arrangeBtn.addEventListener("click", () => {
      stopTour();
      simState.arrangeMode = !simState.arrangeMode;
      arrangeBtn.classList.toggle("is-selected", simState.arrangeMode);
      setHotspot("displays");
      renderDashboard();
    });
  }

  const identifyBtn = document.getElementById("sim-identify-btn");
  if (identifyBtn) {
    identifyBtn.addEventListener("click", () => {
      stopTour();
      simState.identifyFlash = true;
      setHotspot("displays");
      renderDashboard();
      setTimeout(() => {
        simState.identifyFlash = false;
        renderDashboard();
      }, 1500);
    });
  }

  const calibrateBtn = document.getElementById("sim-calibrate-btn");
  if (calibrateBtn) {
    calibrateBtn.addEventListener("click", () => {
      stopTour();
      setHotspot("pose");
      if (calFeedback) {
        calFeedback.textContent = `Calibrated Display ${simState.focusedMonitor + 1} anchor! Press Space in app to sample all.`;
      }
    });
  }

  document.querySelectorAll(".fps-group .mini-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopTour();
      simState.fps = Number(btn.dataset.fps);
      document
        .querySelectorAll(".fps-group .mini-btn")
        .forEach((b) => b.classList.toggle("is-selected", b === btn));
      setHotspot("settings");
      renderDashboard();
    });
  });

  const marginSlider = document.getElementById("sim-margin-slider");
  const marginVal = document.getElementById("sim-margin-val");
  if (marginSlider && marginVal) {
    marginSlider.addEventListener("input", () => {
      stopTour();
      simState.marginDeg = Number(marginSlider.value);
      marginVal.textContent = `${simState.marginDeg}°`;
      setHotspot("settings");
      renderDashboard();
    });
  }

  const dwellSlider = document.getElementById("sim-dwell-slider");
  const dwellVal = document.getElementById("sim-dwell-val");
  if (dwellSlider && dwellVal) {
    dwellSlider.addEventListener("input", () => {
      stopTour();
      simState.dwellMs = Number(dwellSlider.value);
      dwellVal.textContent = `${simState.dwellMs} ms`;
      setHotspot("settings");
      renderDashboard();
    });
  }

  const masterToggle = document.getElementById("sim-master-toggle");
  if (masterToggle) {
    masterToggle.addEventListener("change", () => {
      stopTour();
      simState.trackingEnabled = masterToggle.checked;
      renderStatus();
    });
  }

  const yieldToggle = document.getElementById("sim-yield-toggle");
  if (yieldToggle) {
    yieldToggle.addEventListener("change", () => {
      stopTour();
      simState.yieldActive = yieldToggle.checked;
      setHotspot("safeguards");
      renderStatus();
    });
  }

  const fullscreenToggle = document.getElementById("sim-fullscreen-toggle");
  if (fullscreenToggle) {
    fullscreenToggle.addEventListener("change", () => {
      stopTour();
      simState.fullscreenActive = fullscreenToggle.checked;
      setHotspot("safeguards");
      renderStatus();
    });
  }

  // Guided Tour ("Watch Demo" + Toggle button)
  const tourToggleBtn = document.getElementById("tour-toggle-btn");
  const tourToggleText = document.getElementById("tour-toggle-text");
  const watchDemoLink = document.getElementById("watch-demo-link");

  function stopTour() {
    if (simState.tourTimer) {
      clearInterval(simState.tourTimer);
      simState.tourTimer = null;
    }
    if (tourToggleText) tourToggleText.textContent = "Play Guided Tour";
  }

  function startTour() {
    stopTour();
    const sequence = [
      () => {
        simState.topo = "1over2";
        simState.focusedMonitor = 0;
        simState.yieldActive = false;
        setHotspot("displays");
      },
      () => {
        simState.focusedMonitor = 2;
        setHotspot("pose");
      },
      () => {
        simState.fps = 24;
        setHotspot("settings");
      },
      () => {
        simState.yieldActive = true;
        setHotspot("safeguards");
      },
      () => {
        simState.yieldActive = false;
        simState.topo = "2x1";
        simState.fps = 15;
        simState.focusedMonitor = 1;
        setHotspot("displays");
      },
    ];

    let step = 0;
    if (tourToggleText) tourToggleText.textContent = "Stop Guided Tour";
    const runStep = () => {
      sequence[step]();
      document.querySelectorAll(".topo-pills .mini-btn").forEach((b) =>
        b.classList.toggle("is-selected", b.dataset.topo === simState.topo)
      );
      document.querySelectorAll(".fps-group .mini-btn").forEach((b) =>
        b.classList.toggle("is-selected", Number(b.dataset.fps) === simState.fps)
      );
      if (yieldToggle) yieldToggle.checked = simState.yieldActive;
      renderDashboard();
      step = (step + 1) % sequence.length;
    };

    runStep();
    simState.tourTimer = setInterval(runStep, 2600);
  }

  if (tourToggleBtn) {
    tourToggleBtn.addEventListener("click", () => {
      if (simState.tourTimer) stopTour();
      else startTour();
    });
  }

  if (watchDemoLink) {
    watchDemoLink.addEventListener("click", () => {
      setTimeout(startTour, 250);
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Copy Build Snippet & Subtle Scroll Reveal
  // ---------------------------------------------------------------------------
  const copyBtn = document.getElementById("copy-build-btn");
  const buildCommands = document.getElementById("build-commands");
  if (copyBtn && buildCommands) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(buildCommands.textContent.trim());
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1600);
      } catch {
        copyBtn.textContent = "Copy manually";
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  setHotspot("displays");
  renderDashboard();
  hydrateGitHubData();
})();
