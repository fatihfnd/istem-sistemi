// ocr.js — Yeni İstek formundaki "tara" butonu: lam etiketindeki Patoloji
// No'yu kameradan okur (Tesseract.js, tarayıcıda — görüntü hiçbir sunucuya
// gönderilmez).
//
// Akış: kamera açılır → kullanıcı patoloji no satırını sabit çerçeveye
// hizalar → "Yakala" → SADECE çerçeve içi kırpılır → gri ton + medyan
// filtre + ortalama tabanlı eşikleme → Tesseract (yalnız rakam ve "/",
// tek satır) → sonuç /^\d+\/\d{2}$/ kalıbına uymazsa hiçbir şey
// doldurulmaz ("okunamadı, elle girin"); uyarsa düzenlenebilir bir kutuda
// gösterilir, kullanıcı "Kullan" deyince forma yazılır. Form ASLA
// kendiliğinden gönderilmez; Blok No'ya dokunulmaz.
//
// Tesseract.js yalnızca ilk "tara"da CDN'den yüklenir (her sayfa açılışında
// değil). Dil verisi Tesseract'ın kendi IndexedDB önbelleğine yazılır,
// sonraki açılışlar hızlıdır.
(function () {
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const PAT_RE = /^\d+\/\d{2}$/;
  // Yükleme: betik + çekirdek (wasm) + dil verisi ilk seferde birkaç MB.
  const SURE_YUKLEME = 45000, SURE_TANIMA = 20000;
  const MESAJ_BAGLANTI = "Bağlantı yavaş ya da çevrimdışı — OCR bileşeni yüklenemedi. Patoloji No'yu elle girin.";

  function zamanAsimi(p, ms, mesaj) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(mesaj), { zamanAsimi: true })), ms); })])
      .finally(() => clearTimeout(t));
  }

  // ---------------- Tesseract (tembel yükleme, oturum boyunca tek worker) ----------------
  let scriptP = null, workerP = null;
  function tesseractYukle() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!scriptP) {
      scriptP = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL;
        s.async = true;
        s.onload = () => (window.Tesseract ? res(window.Tesseract) : rej(new Error(MESAJ_BAGLANTI)));
        s.onerror = () => rej(new Error(MESAJ_BAGLANTI));
        document.head.appendChild(s);
      });
      scriptP.catch(() => { scriptP = null; }); // bir sonraki denemede yeniden
    }
    return scriptP;
  }
  // Zaman aşımı sadece BEKLEMEYİ keser — yükleme arka planda sürer, bitince
  // worker bir sonraki deneme için hazır olur.
  function workerHazirla() {
    if (!workerP) {
      workerP = (async () => {
        const T = await tesseractYukle();
        const w = await T.createWorker("eng", 1); // 1 = LSTM
        await w.setParameters({
          tessedit_char_whitelist: "0123456789/",
          tessedit_pageseg_mode: T.PSM.SINGLE_LINE, // psm 7: tek satır
        });
        return w;
      })();
      workerP.catch(() => { workerP = null; });
    }
    return zamanAsimi(workerP, SURE_YUKLEME, MESAJ_BAGLANTI);
  }
  async function tani(canvas) {
    const w = await workerHazirla();
    try {
      const { data } = await zamanAsimi(w.recognize(canvas), SURE_TANIMA, "Okuma zaman aşımına uğradı — tekrar deneyin ya da elle girin.");
      return String(data.text || "").replace(/\s+/g, "");
    } catch (e) {
      if (e.zamanAsimi) { // takılmış worker'ı at, sonraki denemede yenisi kurulur
        workerP = null;
        w.terminate().catch(() => {});
      }
      throw e;
    }
  }

  // ---------------- Görüntü işleme ----------------
  // Ekrandaki çerçevenin kapsadığı alanı videonun GERÇEK piksellerinde bulur
  // (video object-fit: cover ile ölçeklenip kırpılarak gösteriliyor) ve
  // sadece o bölgeyi bir canvas'a alır. Küçük kamerada metin Tesseract için
  // fazla alçak kalmasın diye yükseklik en az ~160 px'e büyütülür.
  function cerceveyiKirp(video, frame) {
    const vr = video.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const olcek = Math.max(vr.width / vw, vr.height / vh);
    const ox = (vr.width - vw * olcek) / 2, oy = (vr.height - vh * olcek) / 2;
    const sx = Math.max(0, (fr.left - vr.left - ox) / olcek);
    const sy = Math.max(0, (fr.top - vr.top - oy) / olcek);
    const sw = Math.min(vw - sx, fr.width / olcek);
    const sh = Math.min(vh - sy, fr.height / olcek);
    const k = Math.min(3, 1600 / sw, Math.max(1, 160 / sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * k);
    c.height = Math.round(sh * k);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  // Gri ton → 3×3 medyan (tuz-biber gürültüsü) → yerel ORTALAMA tabanlı
  // eşikleme (Bradley: pikseli çevresindeki pencerenin ortalamasıyla
  // kıyaslar — lam etiketinde gölge/ışık farkına tek bir global eşikten
  // dayanıklı). Tesseract koyu yazı / açık zemin bekler; çoğunluk koyu
  // çıkarsa (açık yazı, koyu zemin) ters çevrilir. Kenara beyaz pay eklenir.
  function isle(kaynak) {
    const w = kaynak.width, h = kaynak.height, n = w * h;
    const src = kaynak.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;

    const gri = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) gri[i] = (src[j] * 299 + src[j + 1] * 587 + src[j + 2] * 114) / 1000;

    const med = new Uint8Array(n);
    const p = new Uint8Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
          for (let dx = -1; dx <= 1; dx++) p[m++] = gri[yy + Math.min(w - 1, Math.max(0, x + dx))];
        }
        for (let a = 1; a < 9; a++) { const v = p[a]; let b = a - 1; while (b >= 0 && p[b] > v) { p[b + 1] = p[b]; b--; } p[b + 1] = v; }
        med[y * w + x] = p[4];
      }
    }

    // integral görüntü → her pencerenin ortalaması O(1)
    const W1 = w + 1;
    const ig = new Float64Array(W1 * (h + 1));
    for (let y = 1; y <= h; y++) {
      let satir = 0;
      for (let x = 1; x <= w; x++) { satir += med[(y - 1) * w + (x - 1)]; ig[y * W1 + x] = ig[(y - 1) * W1 + x] + satir; }
    }
    const r = Math.max(8, Math.round(h / 3)), T = 0.15;
    const ikili = new Uint8Array(n);
    let koyu = 0;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const say = (x1 - x0 + 1) * (y1 - y0 + 1);
        const top = ig[(y1 + 1) * W1 + (x1 + 1)] - ig[y0 * W1 + (x1 + 1)] - ig[(y1 + 1) * W1 + x0] + ig[y0 * W1 + x0];
        const siyah = med[y * w + x] * say <= top * (1 - T);
        ikili[y * w + x] = siyah ? 0 : 255;
        if (siyah) koyu++;
      }
    }
    const ters = koyu > n / 2;

    const PAY = 16;
    const out = document.createElement("canvas");
    out.width = w + PAY * 2;
    out.height = h + PAY * 2;
    const octx = out.getContext("2d");
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, out.width, out.height);
    const img = octx.createImageData(w, h), d = img.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = ters ? 255 - ikili[i] : ikili[i]; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    octx.putImageData(img, PAY, PAY);
    return out;
  }

  // ---------------- Arayüz ----------------
  let ov = null, akis = null;

  function kapat() {
    if (akis) { akis.getTracks().forEach((t) => t.stop()); akis = null; }
    if (ov) { ov.remove(); ov = null; }
    document.removeEventListener("keydown", escKapat);
  }
  function escKapat(e) { if (e.key === "Escape") kapat(); }

  function durum(metin, hata) {
    const el = ov && ov.querySelector(".ocr-durum");
    if (!el) return;
    el.textContent = metin || "";
    el.classList.toggle("hata", Boolean(hata));
  }
  // "kamera" | "isleniyor" | "sonuc" | "okunamadi" | "hata"
  function asama(a) {
    if (!ov) return;
    const goster = { yakala: a === "kamera" || a === "isleniyor", tekrar: a === "sonuc" || a === "okunamadi", kullan: a === "sonuc" };
    Object.entries(goster).forEach(([k, v]) => { ov.querySelector(`[data-ocr="${k}"]`).hidden = !v; });
    ov.querySelector('[data-ocr="yakala"]').disabled = a !== "kamera";
    ov.querySelector('[data-ocr="iptal"]').textContent = a === "sonuc" || a === "kamera" || a === "isleniyor" ? "İptal" : "Kapat";
    ov.querySelector(".ocr-sonuc").hidden = a !== "sonuc";
    ov.querySelector(".ocr-onizleme").hidden = !(a === "isleniyor" || a === "sonuc" || a === "okunamadi");
    ov.classList.toggle("donuk", a !== "kamera");
  }

  async function yakala(onSonuc) {
    const video = ov.querySelector("video"), frame = ov.querySelector(".ocr-frame");
    if (!video.videoWidth) return;
    asama("isleniyor");
    durum("Okunuyor…");
    video.pause(); // kullanıcı neyin okunduğunu görsün
    try {
      const ikili = isle(cerceveyiKirp(video, frame));
      const on = ov.querySelector(".ocr-onizleme");
      on.width = ikili.width; on.height = ikili.height;
      on.getContext("2d").drawImage(ikili, 0, 0);
      if (!window.Tesseract || !workerP) durum("OCR bileşeni hazırlanıyor (ilk seferde birkaç saniye)…");
      const metin = await tani(ikili);
      if (!ov) return; // bu arada kapatıldı
      if (PAT_RE.test(metin)) {
        asama("sonuc");
        durum("");
        const inp = ov.querySelector(".ocr-sonuc input");
        inp.value = metin;
        inp.focus();
        inp.select();
      } else {
        asama("okunamadi");
        durum(`Okunamadı${metin ? ` ("${metin}" — kalıba uymuyor)` : ""}. Tekrar deneyin ya da Patoloji No'yu elle girin.`, true);
      }
    } catch (e) {
      if (!ov) return;
      asama("okunamadi");
      durum(e && e.message ? e.message : "Okunamadı — elle girin.", true);
    }
    ov.querySelector('[data-ocr="kullan"]').onclick = () => {
      const v = ov.querySelector(".ocr-sonuc input").value.trim();
      if (!v) { durum("Boş bırakılamaz — düzeltin ya da İptal'e basın.", true); return; }
      kapat();
      onSonuc(v);
    };
  }

  async function ac({ onSonuc }) {
    kapat();
    ov = document.createElement("div");
    ov.className = "ocr-ov";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Patoloji No tara");
    ov.innerHTML = `
      <div class="ocr-stage">
        <video playsinline muted autoplay></video>
        <div class="ocr-frame" aria-hidden="true"></div>
      </div>
      <div class="ocr-panel">
        <div class="ocr-ipucu">Lam etiketindeki <b>patoloji no satırını</b> çerçevenin içine hizalayın, sonra "Yakala"ya basın.</div>
        <canvas class="ocr-onizleme" hidden></canvas>
        <div class="ocr-sonuc" hidden>
          <label for="ocrDeger">Okunan Patoloji No — kontrol edin, gerekirse düzeltin</label>
          <input id="ocrDeger" class="finput" autocomplete="off" inputmode="numeric">
        </div>
        <div class="ocr-durum" role="status" aria-live="polite"></div>
        <div class="ocr-btns">
          <button type="button" class="btn-ghost" data-ocr="iptal">İptal</button>
          <button type="button" class="btn-ghost" data-ocr="tekrar" hidden>Tekrar Dene</button>
          <button type="button" class="btn-primary" data-ocr="yakala" disabled>Yakala</button>
          <button type="button" class="btn-primary" data-ocr="kullan" hidden>Kullan</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.addEventListener("keydown", escKapat);
    ov.querySelector('[data-ocr="iptal"]').onclick = kapat;
    ov.querySelector('[data-ocr="yakala"]').onclick = () => yakala(onSonuc);
    ov.querySelector('[data-ocr="tekrar"]').onclick = () => {
      asama("kamera");
      durum("");
      ov.querySelector("video").play().catch(() => {});
    };
    ov.querySelector(".ocr-sonuc input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); ov.querySelector('[data-ocr="kullan"]').click(); }
    });
    asama("kamera");

    if (!navigator.onLine && !window.Tesseract) durum("Çevrimdışısınız — OCR bileşeni yüklenemeyebilir; okunamazsa elle girin.", true);
    workerHazirla().catch(() => {}); // kamera açılırken arka planda hazırla

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      asama("hata");
      durum("Kamera bu bağlantıda kullanılamıyor (güvenli bağlantı/HTTPS gerekli). Patoloji No'yu elle girin.", true);
      return;
    }
    try {
      akis = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (!ov) { akis.getTracks().forEach((t) => t.stop()); akis = null; return; }
      const video = ov.querySelector("video");
      video.srcObject = akis;
      await video.play().catch(() => {});
      const hazir = () => { if (ov && video.videoWidth) ov.querySelector('[data-ocr="yakala"]').disabled = false; };
      video.addEventListener("loadedmetadata", hazir);
      hazir();
    } catch (e) {
      if (!ov) return;
      asama("hata");
      const ad = e && e.name;
      durum(ad === "NotAllowedError" ? "Kamera izni verilmedi — tarayıcı ayarlarından izin verin ya da Patoloji No'yu elle girin."
        : ad === "NotFoundError" || ad === "OverconstrainedError" ? "Kamera bulunamadı — Patoloji No'yu elle girin."
        : ad === "NotReadableError" ? "Kamera başka bir uygulama tarafından kullanılıyor — kapatıp tekrar deneyin."
        : "Kamera açılamadı — Patoloji No'yu elle girin.", true);
    }
  }

  window.PatolojiOCR = { ac, kapat, PAT_RE, _ic: { isle, tani, cerceveyiKirp } }; // _ic: test/hata ayıklama içindir
})();
