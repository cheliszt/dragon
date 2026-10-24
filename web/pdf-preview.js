const $ = (id) => document.getElementById(id);
let currentUrl;
let documentTask;
let documentPdf;
let pageNumber = 1;
let renderTask;
let revision = 0;
let renderRevision = 0;
let resizeTimer;

function controls(disabled = false) {
  $("previous-page").disabled = disabled || !documentPdf || pageNumber <= 1;
  $("next-page").disabled = disabled || !documentPdf || pageNumber >= documentPdf.numPages;
  $("page-number").disabled = disabled || !documentPdf;
  $("page-number").value = pageNumber;
  $("page-number").max = documentPdf?.numPages || 1;
  $("page-count").textContent = `/ ${documentPdf?.numPages || "—"}`;
}

async function renderPage() {
  if (!documentPdf || $("pdf-preview").hidden) return;
  const version = ++renderRevision;
  if (renderTask) {
    renderTask.cancel();
    try { await renderTask.promise; } catch {}
  }
  controls(true);
  try {
    const page = await documentPdf.getPage(pageNumber);
    if (version !== renderRevision) return;
    const natural = page.getViewport({ scale: 1 });
    const width = Math.max(200, $("pdf-pages").clientWidth - 24);
    const viewport = page.getViewport({ scale: width / natural.width });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = $("pdf-canvas");
    canvas.width = Math.round(viewport.width * ratio);
    canvas.height = Math.round(viewport.height * ratio);
    canvas.hidden = false;
    renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    await renderTask.promise;
    if (version !== renderRevision) return;
    $("pdf-message").hidden = true;
  } catch (error) {
    if (version !== renderRevision || error.name === "RenderingCancelledException") return;
    $("pdf-message").textContent = "此页无法预览，请通过“打开原件”查看。";
    $("pdf-message").hidden = false;
  } finally { if (version === renderRevision) controls(); }
}

export async function previewPdf(url) {
  if (url === currentUrl) return;
  currentUrl = url;
  const version = ++revision;
  renderRevision += 1;
  renderTask?.cancel();
  documentPdf = null;
  pageNumber = 1;
  controls(true);
  $("pdf-canvas").hidden = true;
  $("pdf-message").textContent = "正在加载原件…";
  $("pdf-message").hidden = false;
  try {
    await documentTask?.destroy();
    documentTask = null;
    if (!url || version !== revision) return;
    const pdfjs = await import("/vendor/pdf.mjs");
    if (version !== revision) return;
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
    documentTask = pdfjs.getDocument({ url, cMapUrl: "/vendor/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/standard_fonts/", wasmUrl: "/vendor/wasm/", isEvalSupported: false });
    documentPdf = await documentTask.promise;
    if (version !== revision) return;
    pageNumber = Math.min(documentPdf.numPages, pageNumber);
    await renderPage();
  } catch (error) {
    if (version !== revision) return;
    $("pdf-message").textContent = error.name === "PasswordException" ? "PDF 有密码保护，请通过“打开原件”查看。" : "预览暂不可用，请通过“打开原件”查看。";
    $("pdf-message").hidden = false;
  }
}

export function showPdfPage(page) {
  // Keep the requested page while the PDF is still loading.
  pageNumber = Math.max(1, Math.trunc(Number(page)) || 1);
  if (documentPdf) pageNumber = Math.min(documentPdf.numPages, pageNumber);
  controls(!documentPdf);
  renderPage();
}

$("previous-page").onclick = () => { if (pageNumber > 1) { pageNumber -= 1; renderPage(); } };
$("next-page").onclick = () => { if (documentPdf && pageNumber < documentPdf.numPages) { pageNumber += 1; renderPage(); } };
$("page-number").onchange = () => {
  pageNumber = Math.max(1, Math.min(documentPdf?.numPages || 1, Math.trunc(Number($("page-number").value)) || 1));
  renderPage();
};
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPage, 150); }).observe($("pdf-pages"));
