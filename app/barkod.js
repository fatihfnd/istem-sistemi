// barkod.js — istem kağıdındaki etiketin DataMatrix barkodunu kameradan okur.
// Barkod yalnız biyopsi / patoloji no'yu içerir (ör. 18788/26). Görüntü hiçbir
// sunucuya gönderilmez; okuma tarayıcıda yapılır.
//
// Okuyucu (ilk taramada bir kez seçilir):
//  1) Tarayıcının yerleşik BarcodeDetector'ı — getSupportedFormats() içinde
//     "data_matrix" varsa (Android Chrome, macOS Chrome). Hiçbir şey indirilmez.
//  2) Yoksa barcode-detector@3.2.2 "ponyfill" (aynı API, global'e dokunmaz) —
//     içinde zxing-cpp'nin WebAssembly derlemesi zxing-wasm@3.1.3 sabitli.
//     Betik (≈44 KB, SRI ile) ve okuyucu wasm'ı (≈1,1 MB, fastly.jsdelivr.net,
//     sabit sürüm) YALNIZ ilk taramada indirilir, sonra tarayıcı önbelleğinden
//     gelir. iOS Safari'de yerleşik okuyucu kapalı olduğundan hep bu yol çalışır.
// Yalnız data_matrix aranır — kağıttaki başka barkodlar yok sayılır.
//
// Akış: kamera açılır (arka kamera; destekliyorsa sürekli otomatik odak,
// sensör yakınlaştırması ve fener) → "Yakala" yok, canlı görüntü sürekli
// taranır (kare hedef çerçevesinin içi tam çözünürlükte; arada bir görüntünün
// tamamı) → okunan değer ^\d+/\d{2}$ kalıbına uyarsa titreşim (destekleniyorsa
// — iOS'ta yok; çerçeve yeşile döner), kamera kapanır, değer onSonuc'a gider.
// Kalıba uymuyorsa hiçbir şey doldurulmaz, uyarı gösterilir, tarama sürer.
// "Elle Gir" her zaman açık.
(function () {
  const PONYFILL_URL = "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js";
  const PONYFILL_SRI = "sha384-KJVUIUGb4pmfpWXfD8j3y9ARn6KoGC2vPC/wNUX1O1ZkYemh0BsuvsmdEU2+wS7O";
  const ZXING_SURUM = "zxing-wasm 3.1.3";
  // Tüm değer kalıba uymalı (^…$) — "18788/26".
  const PAT_RE = /^\d+\/\d{2}$/;
  const FORMATLAR = ["data_matrix"];
  // İki deneme arası bekleme (bir önceki bitmeden yenisi başlamaz).
  const ARALIK = 150;
  // Her TAM_KARE_SIKLIK denemeden biri görüntünün tamamında — barkod çerçevenin
  // dışında kalsa da bulunsun.
  const TAM_KARE_SIKLIK = 4;
  // Okuyucuya giden görüntünün uzun kenarı en fazla (px).
  const KIRPMA_MAKS = 1000, TAM_KARE_MAKS = 1280;
  // Sensör yakınlaştırması (destekleyen kamerada): küçük barkoda daha çok
  // piksel düşer. CSS ile büyütme YAPILMAZ — piksel eklemez, kullanıcıyı
  // telefonu uzak tutmaya iter.
  const ZOOM = 2;
  const SURE_YUKLEME = 30000;
  const MESAJ_YUKLEME = "Barkod okuyucu yüklenemedi (bağlantı yavaş ya da çevrimdışı). Patoloji No'yu elle girin.";

  function zamanAsimi(p, ms, mesaj) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(mesaj)), ms); })])
      .finally(() => clearTimeout(t));
  }

  // ---------------- Okuyucu (oturum boyunca tek örnek) ----------------
  let dedektorP = null, motor = "";
  async function yerlesikDataMatrix() {
    if (!("BarcodeDetector" in window) || typeof window.BarcodeDetector.getSupportedFormats !== "function") return false;
    try { return (await window.BarcodeDetector.getSupportedFormats()).includes("data_matrix"); } catch (e) { return false; }
  }
  function ponyfillYukle() {
    if (window.BarcodeDetectionAPI) return Promise.resolve(window.BarcodeDetectionAPI);
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PONYFILL_URL;
      s.integrity = PONYFILL_SRI;
      s.crossOrigin = "anonymous";
      s.async = true;
      s.onload = () => (window.BarcodeDetectionAPI ? res(window.BarcodeDetectionAPI) : rej(new Error(MESAJ_YUKLEME)));
      s.onerror = () => { s.remove(); rej(new Error(MESAJ_YUKLEME)); };
      document.head.appendChild(s);
    });
  }
  // Hazır olunca ilk karede beklenmesin diye wasm boş bir görüntüyle önceden
  // yüklenir. Başarısız olursa bir sonraki taramada yeniden denenir.
  function dedektorHazirla() {
    if (!dedektorP) {
      dedektorP = (async () => {
        if (await yerlesikDataMatrix()) {
          motor = "tarayıcının yerleşik okuyucusu";
          return new window.BarcodeDetector({ formats: FORMATLAR });
        }
        const api = await ponyfillYukle();
        const d = new api.BarcodeDetector({ formats: FORMATLAR });
        const bos = document.createElement("canvas");
        bos.width = bos.height = 16;
        await d.detect(bos);
        motor = ZXING_SURUM;
        return d;
      })();
      dedektorP.catch(() => { dedektorP = null; });
    }
    return zamanAsimi(dedektorP, SURE_YUKLEME, MESAJ_YUKLEME);
  }

  // ---------------- Görüntü ----------------
  // Ekrandaki çerçevenin kapsadığı alan videonun GERÇEK piksellerinde
  // (video object-fit: cover ile gösteriliyor).
  function cerceveyiKirp(video, frame) {
    const vr = video.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const olcek = Math.max(vr.width / vw, vr.height / vh);
    const ox = (vr.width - vw * olcek) / 2, oy = (vr.height - vh * olcek) / 2;
    const sx = Math.max(0, (fr.left - vr.left - ox) / olcek);
    const sy = Math.max(0, (fr.top - vr.top - oy) / olcek);
    const sw = Math.min(vw - sx, fr.width / olcek);
    const sh = Math.min(vh - sy, fr.height / olcek);
    return ciz(video, sx, sy, sw, sh, KIRPMA_MAKS);
  }
  const tamKare = (video) => ciz(video, 0, 0, video.videoWidth, video.videoHeight, TAM_KARE_MAKS);
  let tuval = null;
  function ciz(video, sx, sy, sw, sh, maks) {
    const k = Math.min(1, maks / Math.max(sw, sh));
    tuval = tuval || document.createElement("canvas");
    tuval.width = Math.max(1, Math.round(sw * k));
    tuval.height = Math.max(1, Math.round(sh * k));
    const ctx = tuval.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, tuval.width, tuval.height);
    return tuval;
  }
  // DataMatrix içinde sonda satır sonu / kontrol karakteri olabilir.
  const temizle = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();

  // ---------------- Arayüz ----------------
  let ov = null, akis = null, fenerAcik = false, zamanlayici = null, oturum = 0;

  function kapat() {
    oturum++; // süren tarama döngüsü kendini bitirsin
    clearTimeout(zamanlayici);
    zamanlayici = null;
    if (akis) { akis.getTracks().forEach((t) => t.stop()); akis = null; } // fener de kapanır
    fenerAcik = false;
    if (ov) { ov.remove(); ov = null; }
    document.removeEventListener("keydown", escKapat);
  }
  function escKapat(e) { if (e.key === "Escape") kapat(); }

  function durum(metin, hata) {
    const el = ov && ov.querySelector(".bk-durum");
    if (!el) return;
    el.textContent = metin || "";
    el.classList.toggle("hata", Boolean(hata));
  }
  function motorYaz() {
    const el = ov && ov.querySelector(".bk-motor");
    if (el) el.textContent = motor ? `Okuyucu: ${motor}` : "";
  }

  // Fener (torch) — yalnız cihaz bildiriyorsa (Android Chrome'da çoğunlukla
  // var; iOS Safari'de genelde yok). Sürekli odak ve sensör yakınlaştırması
  // destekleniyorsa istenir, desteklenmiyorsa sessizce geçilir.
  function kameraOzellikleri() {
    const track = akis && akis.getVideoTracks()[0];
    if (!track || !ov) return;
    const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    if (caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > 1) {
      const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min || 1, ZOOM));
      track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
    }
    const btn = ov.querySelector(".bk-fener");
    btn.hidden = !caps.torch;
    btn.onclick = async () => {
      try {
        await track.applyConstraints({ advanced: [{ torch: !fenerAcik }] });
        fenerAcik = !fenerAcik;
        btn.classList.toggle("on", fenerAcik);
        btn.setAttribute("aria-pressed", String(fenerAcik));
      } catch (e) {
        btn.hidden = true;
        durum("Fener bu cihazda açılamadı.", true);
      }
    };
  }

  // Sürekli tarama — oturum değişince (kapat / yeni açılış) durur.
  function taramayiBaslat(dedektor, onSonuc) {
    const benim = oturum;
    const video = ov.querySelector("video"), frame = ov.querySelector(".bk-frame");
    let sayac = 0, sonUyari = "";
    const dongu = async () => {
      if (benim !== oturum || !ov) return;
      if (video.readyState >= 2 && video.videoWidth) {
        sayac++;
        try {
          const kaynak = sayac % TAM_KARE_SIKLIK === 0 ? tamKare(video) : cerceveyiKirp(video, frame);
          const bulunan = await dedektor.detect(kaynak);
          if (benim !== oturum || !ov) return;
          const degerler = (bulunan || []).map((b) => temizle(b.rawValue)).filter(Boolean);
          const uygun = degerler.find((v) => PAT_RE.test(v));
          if (uygun) {
            if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) { /* desteklenmiyor */ } }
            ov.classList.add("okundu");
            durum(`Okundu: ${uygun}`);
            zamanlayici = setTimeout(() => { if (benim !== oturum) return; kapat(); onSonuc(uygun); }, 250);
            return;
          }
          if (degerler.length && degerler[0] !== sonUyari) {
            sonUyari = degerler[0];
            const g = sonUyari.length > 40 ? `${sonUyari.slice(0, 40)}…` : sonUyari;
            durum(`Barkod okundu ama biyopsi no değil (okunan: "${g}"). Doğru etiketi çerçeveye alın ya da "Elle Gir" ile yazın.`, true);
          }
        } catch (e) {
          // Tek karelik hata (ör. görüntü henüz hazır değil) taramayı durdurmaz.
        }
      }
      if (benim === oturum && ov) zamanlayici = setTimeout(dongu, ARALIK);
    };
    dongu();
  }

  async function ac({ onSonuc, onElle, baslik } = {}) {
    kapat();
    const benim = oturum;
    ov = document.createElement("div");
    ov.className = "bk-ov";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", baslik || "Barkod okut");
    ov.innerHTML = `
      <div class="bk-stage">
        <video playsinline muted autoplay></video>
        <div class="bk-frame" aria-hidden="true"></div>
        <button type="button" class="bk-fener" hidden aria-pressed="false" aria-label="Feneri aç/kapat" title="Fener">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h12v4l-2 4v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10L6 6z"/><path d="M6 6h12M12 13v3"/></svg>
          <span>Fener</span>
        </button>
      </div>
      <div class="bk-panel">
        <div class="bk-ipucu">İstem kağıdındaki etiketin <b>kare barkodunu</b> çerçeveye alın — telefonu <b>10–20 cm</b> uzakta sabit tutun. Okununca kendiliğinden kapanır.</div>
        <div class="bk-durum" role="status" aria-live="polite"></div>
        <div class="bk-alt">
          <span class="bk-motor"></span>
          <div class="bk-btns">
            <button type="button" class="btn-ghost" data-bk="iptal">İptal</button>
            <button type="button" class="btn-ghost" data-bk="elle">Elle Gir</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.addEventListener("keydown", escKapat);
    ov.querySelector('[data-bk="iptal"]').onclick = kapat;
    ov.querySelector('[data-bk="elle"]').onclick = () => { kapat(); if (onElle) onElle(); };

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      durum("Kamera bu bağlantıda kullanılamıyor (güvenli bağlantı/HTTPS gerekli). Patoloji No'yu elle girin.", true);
      return;
    }
    // Okuyucu ve kamera birlikte hazırlanır.
    const dedektorS = dedektorHazirla().then((d) => ({ d }), (e) => ({ hata: e }));
    durum(window.BarcodeDetectionAPI || motor ? "" : "Barkod okuyucu hazırlanıyor…");
    try {
      akis = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: "continuous" }], // desteklemeyen cihazda yok sayılır
        },
        audio: false,
      });
      if (benim !== oturum || !ov) { if (akis) akis.getTracks().forEach((t) => t.stop()); return; }
      const video = ov.querySelector("video");
      video.srcObject = akis;
      await video.play().catch(() => {});
      const hazir = () => { if (ov && video.videoWidth) kameraOzellikleri(); }; // bazı Android'lerde yetenekler ancak görüntü gelince okunuyor
      video.addEventListener("loadedmetadata", hazir);
      hazir();
    } catch (e) {
      if (benim !== oturum || !ov) return;
      const ad = e && e.name;
      durum(ad === "NotAllowedError" ? "Kamera izni verilmedi — tarayıcı ayarlarından izin verin ya da Patoloji No'yu elle girin."
        : ad === "NotFoundError" || ad === "OverconstrainedError" ? "Kamera bulunamadı — Patoloji No'yu elle girin."
        : ad === "NotReadableError" ? "Kamera başka bir uygulama tarafından kullanılıyor — kapatıp tekrar deneyin."
        : "Kamera açılamadı — Patoloji No'yu elle girin.", true);
      return;
    }
    const s = await dedektorS;
    if (benim !== oturum || !ov) return;
    if (s.hata) { durum(s.hata.message || MESAJ_YUKLEME, true); return; }
    motorYaz();
    durum("");
    taramayiBaslat(s.d, onSonuc);
  }

  window.BarkodOkuyucu = { ac, kapat, PAT_RE, _ic: { dedektorHazirla, temizle, motor: () => motor } };
})();
