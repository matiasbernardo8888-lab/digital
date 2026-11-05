// Supabase Edge Function: applyfy-webhook
// Recebe os avisos (webhooks) da Applyfy e libera ou bloqueia o acesso ao Sora pelo e-mail do cliente.
//
// Segurança: a URL desta função é pública. Por isso ela só aceita chamadas com o token secreto
// APPLYFY_WEBHOOK_TOKEN (Edge Functions > Secrets), enviado como ?token=... na URL do webhook
// ou no cabeçalho "x-webhook-token". Sem isso, qualquer pessoa poderia se dar acesso de graça.

type Env = { url: string; serviceKey: string; token: string }
type Action = 'active' | 'refunded' | 'canceled' | 'expired' | null

// ---------- Rate limiting (tabela public.rate_limits + função rate_hit, só o service_role usa) ----------
// Conta acessos por janela de tempo no banco, então vale para todas as instâncias da função.
// Se o banco falhar, deixa passar (não derruba o app por causa do contador).
export function clientIp(req: Request): string {
  const f = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || ''
  return f.split(',')[0].trim().slice(0, 64) || 'sem-ip'
}
export async function rateOk(env: { url: string; serviceKey: string }, doFetch: typeof fetch, key: string, windowSec: number, max: number): Promise<boolean> {
  try {
    const r = await doFetch(`${env.url}/rest/v1/rpc/rate_hit`, {
      method: 'POST',
      headers: { apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_window_seconds: windowSec, p_max: max }),
    })
    if (!r.ok) { console.error('rate_hit', r.status, (await r.text().catch(() => '')).slice(0, 200)); return true }
    return (await r.json()) !== false
  } catch (e) { console.error('rate_hit erro', String(e)); return true }
}
// Várias regras de uma vez: [chave, janela em segundos, máximo, mensagem]
export async function rateCheck(env: { url: string; serviceKey: string }, doFetch: typeof fetch, rules: [string, number, number, string][]): Promise<Response | null> {
  for (const [key, win, max, wait] of rules) {
    if (!(await rateOk(env, doFetch, key, win, max))) {
      console.warn('rate limit', key)
      return new Response(JSON.stringify({ error: `Muitas tentativas em pouco tempo. Aguarde ${wait} e tente de novo.`, rateLimited: true }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(win) },
      })
    }
  }
  return null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function get(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

// E-mail do cliente: caminhos comuns primeiro; se não achar, o primeiro campo "email" válido do corpo.
export function findEmail(body: any): string | null {
  const paths = [
    'customer.email', 'data.customer.email', 'buyer.email', 'data.buyer.email', 'client.email',
    'data.client.email', 'order.customer.email', 'data.order.customer.email', 'payer.email',
    'data.payer.email', 'subscriber.email', 'data.subscriber.email', 'email', 'data.email',
  ]
  for (const p of paths) {
    const v = get(body, p)
    if (typeof v === 'string' && EMAIL_RE.test(v.trim())) return v.trim().toLowerCase()
  }
  const seen = new Set<any>()
  const walk = (o: any, depth: number): string | null => {
    if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return null
    seen.add(o)
    for (const [k, v] of Object.entries(o)) {
      if (/email/i.test(k) && typeof v === 'string' && EMAIL_RE.test(v.trim())) return v.trim().toLowerCase()
    }
    for (const v of Object.values(o)) {
      const r = walk(v, depth + 1)
      if (r) return r
    }
    return null
  }
  return walk(body, 0)
}

// Evento/status do pagamento, normalizado em maiúsculas.
export function findEvent(body: any): string {
  const paths = [
    'event', 'type', 'event_type', 'eventType', 'data.event', 'data.type',
    'status', 'data.status', 'order.status', 'data.order.status', 'payment.status',
    'data.payment.status', 'transaction.status', 'data.transaction.status',
  ]
  // subscription.status fica de fora: a Applyfy manda "INACTIVE" mesmo numa venda paga.
  const found: string[] = []
  for (const p of paths) {
    const v = get(body, p)
    if (typeof v === 'string' && v.trim()) found.push(v.trim().toUpperCase())
  }
  return found.join(' | ')
}

// Plano comprado, pelo nome do produto/oferta da Applyfy: "Vitalício" = 17 sites por mês; o resto = Mensal (ilimitado).
export function findPlan(body: any): 'mensal' | 'vitalicio' | null {
  const names: string[] = []
  const paths = ['product.name', 'data.product.name', 'offer.name', 'data.offer.name', 'plan.name', 'data.plan.name',
    'productName', 'data.productName', 'offerName', 'data.offerName', 'order.product.name', 'data.order.product.name']
  for (const p of paths) { const v = get(body, p); if (typeof v === 'string' && v.trim()) names.push(v) }
  const seen = new Set<any>()
  const walk = (o: any, depth: number, parent: string) => {
    if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return
    seen.add(o)
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^(name|title|nome)$/i.test(k) && /product|offer|plan|item/i.test(parent)) names.push(v)
      else if (v && typeof v === 'object') walk(v, depth + 1, k)
    }
  }
  walk(body, 0, '')
  if (!names.length) return null
  const all = names.join(' | ')
  if (/vital[ií]ci|lifetime|vitalicio/i.test(all)) return 'vitalicio'
  return 'mensal'
}

function classify(s: string): Action | 'ignore' | null {
  // Primeiro os que tiram o acesso (para "PAYMENT_REFUNDED" não ser lido como pago).
  if (/REFUND|REEMBOLS|ESTORN|CHARGEBACK|CHARGE_BACK|DISPUTE|CONTEST|(^|[^A-Z])MED([^A-Z]|$)/.test(s)) return 'refunded'
  if (/EXPIRED|EXPIRAD|VENCID/.test(s)) return 'expired'
  if (/CANCEL|SUSPEND/.test(s)) return 'canceled'
  if (/WAITING|PENDING|PENDENTE|AGUARDANDO|REFUSED|RECUSAD|DECLINED|FAILED|FALHOU|GENERATED|GERAD|CREATED|ABANDON/.test(s)) return 'ignore'
  if (/ORDER_PAID|PAID|PAGO|APPROVED|APROVAD|COMPLETE|CONCLU|CONFIRMED|CONFIRMAD|RENEW|RENOVAD/.test(s)) return 'active'
  return null
}

// Decide pelo campo principal ("event") primeiro; só olha os status se o evento não for reconhecido.
export function decide(event: string): Action {
  if (!event) return null
  for (const part of event.split(' | ')) {
    const c = classify(part)
    if (c) return c === 'ignore' ? null : c
  }
  return null
}

export async function handle(req: Request, env: Env, doFetch: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'GET') return json(200, { ok: true, service: 'applyfy-webhook' })
  if (req.method !== 'POST') return json(200, { ok: true, ignored: 'method' })
  // Webhook só recebe poucos avisos: limita por IP para impedir tentativa de adivinhar o token.
  const ipBlock = await rateCheck(env, doFetch, [['hook:ip:' + clientIp(req), 60, 60, '1 minuto']])
  if (ipBlock) return ipBlock

  if (!env.token) {
    console.error('APPLYFY_WEBHOOK_TOKEN não configurado em Edge Functions > Secrets. Chamada recusada.')
    return json(401, { ok: false, error: 'webhook token not configured' })
  }
  const url = new URL(req.url)
  const auth = req.headers.get('authorization') || ''
  const given =
    url.searchParams.get('token') ||
    req.headers.get('x-webhook-token') ||
    req.headers.get('x-applyfy-token') ||
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '')
  if (!safeEqual(given || '', env.token)) {
    console.warn('Webhook recusado: token ausente ou errado.')
    const bad = await rateCheck(env, doFetch, [['hook:bad:' + clientIp(req), 3600, 10, '1 hora']])
    if (bad) return bad
    return json(401, { ok: false, error: 'unauthorized' })
  }

  let body: any = {}
  const raw = await req.text()
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    body = Object.fromEntries(new URLSearchParams(raw))
  }
  // Log do corpo para conferir o formato da Applyfy (Edge Functions > applyfy-webhook > Logs).
  console.log('applyfy body:', JSON.stringify(body).slice(0, 4000))

  const email = findEmail(body)
  const event = findEvent(body)
  const action = decide(event)
  console.log('applyfy decisão:', JSON.stringify({ email, event, action, plan: findPlan(body) }))

  if (!email || !action) return json(200, { ok: true, ignored: !email ? 'no email' : 'event', event })

  const row: Record<string, unknown> = {
    email,
    status: action,
    last_event: event.slice(0, 200),
    updated_at: new Date().toISOString(),
  }
  const plan = findPlan(body)
  if (action === 'active' && plan) row.plan = plan
  const res = await doFetch(`${env.url}/rest/v1/subscriptions?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey: env.serviceKey,
      authorization: `Bearer ${env.serviceKey}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    console.error('Erro ao gravar assinatura:', res.status, await res.text())
    return json(200, { ok: false, error: 'db', email, action })
  }
  return json(200, { ok: true, email, action })
}

declare const Deno: any
if (typeof Deno !== 'undefined') {
  Deno.serve((req: Request) =>
    handle(req, {
      url: Deno.env.get('SUPABASE_URL') ?? '',
      serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      token: Deno.env.get('APPLYFY_WEBHOOK_TOKEN') ?? '',
    }).catch((err: unknown) => {
      console.error('Erro inesperado no webhook:', err)
      return json(200, { ok: false, error: 'unexpected' })
    })
  )
}
