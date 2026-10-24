/*
 * Login do Sora (Supabase Auth) — usado pelo index.html e pelo login.html.
 * A URL e a chave "publishable" do Supabase são públicas por natureza (vão para o
 * navegador de qualquer forma). NUNCA coloque aqui a chave secreta / service_role.
 */
(function () {
  var SUPABASE_URL = 'https://aemnqozofjmvuweyyekp.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_IAVQ5rEZn8qju3KWwPqTHw_E3kB9r1k';

  if (!window.supabase || !window.supabase.createClient) {
    document.documentElement.style.visibility = '';
    document.write('<p style="font-family:sans-serif;color:#fff;padding:24px">Não foi possível carregar o login. Verifique sua internet e recarregue a página.</p>');
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.soraAuth = client;

  var page = (document.body && document.body.getAttribute('data-page')) || document.documentElement.getAttribute('data-page');

  // Página protegida (index.html): sem sessão, vai para o login.
  if (page !== 'login') {
    client.auth.getSession().then(function (res) {
      if (!res.data || !res.data.session) {
        window.location.replace('login.html');
        return;
      }
      document.documentElement.style.visibility = '';
      addLogoutButton();
    });
    client.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_OUT' || !session) window.location.replace('login.html');
    });
  }

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
        client.auth.signOut().finally(function () { window.location.replace('login.html'); });
      });
      document.body.appendChild(b);
    };
    if (document.body) make(); else document.addEventListener('DOMContentLoaded', make);
  }
})();
