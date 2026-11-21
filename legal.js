// Aviso de armazenamento essencial (LGPD). Só informa: o SORA não usa cookies opcionais.
(function () {
  var KEY = 'sora-aviso-cookies-v1';
  try { if (localStorage.getItem(KEY)) return; } catch (e) {}
  function show() {
    if (document.getElementById('sora-cookies')) return;
    var d = document.createElement('div');
    d.id = 'sora-cookies';
    d.setAttribute('role', 'region');
    d.setAttribute('aria-label', 'Aviso de cookies');
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147483000;max-width:640px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:14px 16px;border-radius:18px;background:rgba(26,31,40,.97);border:1px solid #2B323D;box-shadow:0 18px 48px rgba(0,0,0,.6);color:#E9E5FA;font:14px/1.5 Inter,system-ui,-apple-system,sans-serif';
    d.innerHTML = '<p style="margin:0;flex:1 1 260px">O SORA usa só armazenamento essencial para manter seu login e suas preferências. Nada de cookies de anúncio ou rastreamento. Veja a <a href="/cookies" style="color:#7FE3F5">Política de Cookies</a> e a <a href="/privacidade" style="color:#7FE3F5">Política de Privacidade</a>.</p>' +
      '<button type="button" style="min-height:44px;padding:0 20px;border:0;border-radius:999px;background:#0A7898;color:#fff;font:700 14px Inter,system-ui,sans-serif;cursor:pointer">Entendi</button>';
    d.querySelector('button').addEventListener('click', function () {
      try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
      d.remove();
      document.body.style.paddingBottom = prev;
    });
    var prev = document.body.style.paddingBottom;
    document.body.appendChild(d);
    // Deixa espaço no fim da página para o aviso não cobrir botões.
    document.body.style.paddingBottom = (d.offsetHeight + 28) + 'px';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
