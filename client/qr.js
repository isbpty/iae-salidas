function drawQRs() {
  document.querySelectorAll('.qrc[data-qr]').forEach((c) => {
    if (c.childNodes.length) return;
    if (window.QRCode) { try { new QRCode(c, { text: c.dataset.qr, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { c.style.display = 'none'; } }
    else c.style.display = 'none';
  });
}
