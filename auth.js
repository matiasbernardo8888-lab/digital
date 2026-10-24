/*
 * Login do Sora (Supabase Auth) — usado pelo index.html e pelo login.html.
 * A URL e a chave "publishable" do Supabase são públicas por natureza (vão para o
 * navegador de qualquer forma). NUNCA coloque aqui a chave secreta / service_role.
 */
(function () {
  var SUPABASE_URL = 'https://aemnqozofjmvuweyyekp.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_IAVQ5rEZn8qju3KWwPqTHw_E3kB9r1k';
  var STORAGE_KEY = 'sb-aemnqozofjmvuweyyekp-auth-token';

  var page = document.documentElement.getAttribute('data-page') ||
    (document.body && document.body.getAttribute('data-page'));
  var isLogin = page === 'login';

  // Mostra a página. Usa valores explícitos para vencer tanto o estilo inline quanto
  // uma regra CSS como <style>html{visibility:hidden;opacity:0}</style>.
  function reveal() {
    document.documentElement.style.setProperty('visibility', 'visible', 'important');
    document.documentElement.style.setProperty('opacity', '1', 'important');
  }
  function toLogin() {
    window.location.replace('login.html');
  }

  if (!window.supabase || !window.supabase.createClient) {
    reveal();
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML = '<p style="font-family:sans-serif;color:#fff;padding:24px">Não foi possível carregar o login. Verifique sua internet e recarregue a página.</p>';
    });
    return;
  }

  var options = { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true };
  // Trava só dentro desta aba: outra aba do site aberta não segura a sessão desta.
  if (window.supabase.processLock) options.lock = window.supabase.processLock;

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: options });
  window.soraAuth = client;

  // Sessão salva neste navegador e ainda válida? (usado só se o Supabase não responder)
  function storedSessionValid() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      var exp = s && (s.expires_at || (s.currentSession && s.currentSession.expires_at));
      return !!(s && (s.access_token || s.currentSession)) && (!exp || exp * 1000 > Date.now());
    } catch (e) {
      return false;
    }
  }

  if (isLogin) return;

  // Página protegida (index.html). Nunca fica escondida: ou aparece, ou vai para o login.
  var decided = false;
  function decide(hasSession) {
    if (decided) return;
    decided = true;
    if (hasSession) {
      reveal();
      addLogoutButton();
    } else {
      toLogin();
    }
  }

  client.auth.getSession().then(
    function (res) { decide(!!(res && res.data && res.data.session)); },
    function () { decide(storedSessionValid()); }
  );
  // Rede lenta ou Supabase fora do ar: decide pelo que está salvo neste navegador.
  setTimeout(function () { decide(storedSessionValid()); }, 6000);

  client.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') toLogin();
  });

  function addLogoutButton() {
    var make = function () {
      if (document.getElementById('sora-logout')) return;
      var b = document.createElement('button');
      b.id = 'sora-logout';
      b.type = 'button';
      b.textContent = 'Sair';
      b.setAttribute('aria-label', 'Sair da conta');
      b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:50;height:48px;padding:0 20px;border-radius:999px;border:1px solid rgba(201,184,255,.45);background:rgba(28,22,64,.92);color:#fff;font:600 14px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 12px 32px rgba(3,8,24,.55);backdrop-filter:blur(12px)';
      b.addEventListener('click', function () {
        b.disabled = true;
        b.textContent = 'Saindo…';
        var done = function () {
          try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
          toLogin();
        };
        client.auth.signOut().then(done, done);
        setTimeout(done, 4000);
      });
      document.body.appendChild(b);
    };
    if (document.body) make(); else document.addEventListener('DOMContentLoaded', make);
  }
})();
