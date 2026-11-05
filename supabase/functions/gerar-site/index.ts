// Supabase Edge Function: gerar-site
// Recebe o Meta Prompt de um nicho e devolve um site completo (um arquivo HTML) gerado por IA via OpenRouter.
//
// Segurança:
// - A chave OPENROUTER_API_KEY fica só nos Secrets do Supabase; nunca vai para o navegador.
// - Só aceita quem está logado no Sora (token da sessão) E tem assinatura ativa na tabela subscriptions,
//   para ninguém gastar o saldo do OpenRouter de graça.

type Env = { url: string; serviceKey: string; anonKey: string; openrouterKey: string }

const MODEL = 'google/gemini-2.5-flash'
const MAX_PROMPT = 20000
const LIFETIME_LIMIT = 17 // criações de site por mês no plano Vitalício

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

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
        status: 429, headers: { ...cors, 'content-type': 'application/json', 'retry-after': String(win) },
      })
    }
  }
  return null
}

const SYSTEM = [
  'Você é um desenvolvedor web sênior que cria sites profissionais para pequenas empresas na Europa.',
  'Responda APENAS com um único arquivo HTML completo, começando em <!doctype html> e terminando em </html>.',
  'Todo o CSS e o JavaScript ficam dentro do próprio arquivo. Nada de markdown, comentários fora do HTML ou explicações.',
  'O site precisa ser responsivo (celular primeiro), acessível, com textos reais e convincentes no idioma pedido,',
  'botão de WhatsApp quando houver número, e imagens apenas de URLs públicas estáveis (ex.: images.unsplash.com) ou sem imagens.',
].join(' ')

// O Meta Prompt do Sora pede um "prompt para outra IA". Aqui ele vira só o briefing: a IA deve entregar o site pronto.
const BRIEF = [
  'O texto abaixo é um BRIEFING (escrito como pedido de prompt para outra IA).',
  'NÃO escreva um prompt e NÃO explique nada: use o briefing (nicho, público, estratégia, seções, textos, dados da empresa e idioma)',
  'para criar AGORA o site final, completo e pronto para publicar.',
  'Ignore pedidos de React, Vite, build ou vários arquivos: entregue UM único arquivo HTML com CSS e JavaScript embutidos',
  '(pode usar Tailwind pelo CDN https://cdn.tailwindcss.com). Escreva toda a copy de verdade, sem lorem ipsum.',
  'Sua resposta deve começar exatamente com <!doctype html>.',
  '',
  '=== BRIEFING ===',
  '',
].join('\n')

// Modo "content": a IA escreve só o CONTEÚDO do site em JSON e o Sora monta o visual com o modelo premium.
const SYSTEM_CONTENT = [
  'Você é redator publicitário e diretor de arte de uma agência que cria sites premium para pequenas empresas na Europa.',
  'Responda APENAS com um objeto JSON válido (sem markdown, sem comentários, sem texto antes ou depois).',
  'Escreva textos curtos, específicos e convincentes, no idioma pedido. Nunca invente preços, prêmios, números ou depoimentos.',
].join(' ')

// ---------- Fotos do nicho geradas por IA (quando o cliente não tem fotos) ----------
// O servidor monta o pedido da imagem: o navegador só escolhe o tipo de foto. Assim ninguém usa a chave para outras imagens.
const IMG_MODELS = ['bytedance-seed/seedream-4.5', 'google/gemini-2.5-flash-image']
export const SHOTS: Record<string, { aspect: string; text: string }> = {
  hero: { aspect: '16:9', text: 'Wide establishing photograph of the inside of a {N}, beautifully decorated and inviting, ready to welcome customers' },
  servico: { aspect: '4:3', text: 'Close-up photograph of a professional\'s hands performing a typical service of a {N}, faces not visible' },
  detalhe: { aspect: '4:3', text: 'Detail still-life photograph of the tools, products or materials used in a {N}, arranged with care, shallow depth of field' },
  ambiente: { aspect: '4:5', text: 'Cozy corner of a {N} with comfortable seating and decor, soft natural window light' },
  cliente: { aspect: '4:3', text: 'Candid photograph of a satisfied customer being attended at a {N}, people seen from the side or from behind, no recognizable faces' },
}
const clip = (v: unknown, n: number) => String(v || '').replace(/[\r\n<>{}`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
export function photoPrompt(shot: string, nicho: string, cidade: string, estilo: string): string {
  const sh = SHOTS[shot] || SHOTS.hero
  const n = clip(nicho, 60) || 'local business'
  return [
    sh.text.replace('{N}', n + (clip(cidade, 60) ? ` in ${clip(cidade, 60)}` : '')) + '.',
    estilo ? `Color palette and mood: ${clip(estilo, 80)}.` : '',
    'Photorealistic high-end commercial photography, natural colors, professional lighting, sharp focus, rich detail.',
    'No text, no letters, no signage, no logos, no watermarks, no brand names.',
  ].filter(Boolean).join(' ')
}
async function genImage(env: Env, doFetch: typeof fetch, prompt: string, aspect: string): Promise<string> {
  let last = ''
  for (const model of IMG_MODELS) {
    for (const body of [
      { model, prompt, n: 1, aspect_ratio: aspect, resolution: '2K' },
      { model, prompt, n: 1, aspect_ratio: aspect },
    ]) {
      const r = await doFetch('https://openrouter.ai/api/v1/images', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.openrouterKey}`, 'content-type': 'application/json', 'http-referer': 'https://digital-one-zeta.vercel.app', 'x-title': 'Sora' },
        body: JSON.stringify(body),
      })
      const j: any = await r.json().catch(() => ({}))
      const d = j?.data?.[0]
      if (r.ok && d?.b64_json) return `data:${d.media_type || 'image/png'};base64,${d.b64_json}`
      if (r.ok && d?.url) return d.url
      last = `${model} ${r.status} ${JSON.stringify(j).slice(0, 200)}`
      console.error('foto IA falhou', last)
      if (r.status !== 400 && r.status !== 422) break // erro que não é de parâmetro: tenta o próximo modelo
    }
  }
  throw new Error(last || 'sem imagem')
}

export function parseContent(text: string): any {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a === -1 || b <= a) return null
  try { const o = JSON.parse(t.slice(a, b + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null } catch { return null }
}

export function cleanHtml(text: string): string {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.search(/<!doctype html|<html/i)
  if (start > 0) t = t.slice(start)
  const end = t.toLowerCase().lastIndexOf('</html>')
  if (end !== -1) t = t.slice(0, end + 7)
  return t
}

export async function handle(req: Request, env: Env, doFetch: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' })
  if (!env.openrouterKey) return json(500, { error: 'Chave da IA não configurada no servidor.' })
  const ip = clientIp(req)
  const ipBlock = await rateCheck(env, doFetch, [['gen:ip:' + ip, 60, 30, '1 minuto']])
  if (ipBlock) return ipBlock

  // 1) Quem é o usuário? (valida o token da sessão no próprio Supabase Auth)
  const auth = req.headers.get('authorization') || ''
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : ''
  if (!token) return json(401, { error: 'Faça login para criar sites.' })
  const userRes = await doFetch(`${env.url}/auth/v1/user`, {
    headers: { apikey: env.anonKey || env.serviceKey, authorization: `Bearer ${token}` },
  })
  if (!userRes.ok) return json(401, { error: 'Sessão expirada. Entre novamente.' })
  const user = await userRes.json()
  const email = String(user?.email || '').toLowerCase()
  if (!email) return json(401, { error: 'Sessão inválida. Entre novamente.' })

  // 2) Tem assinatura ativa?
  const subRes = await doFetch(
    `${env.url}/rest/v1/subscriptions?select=*&email=eq.${encodeURIComponent(email)}`,
    { headers: { apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}` } },
  )
  const subs = subRes.ok ? await subRes.json() : []
  const sub = Array.isArray(subs) ? subs[0] : null
  const notExpired = !sub?.expires_at || new Date(sub.expires_at).getTime() > Date.now()
  if (!sub || sub.status !== 'active' || !notExpired) {
    return json(403, { error: 'Sua conta não tem uma assinatura ativa do Sora.' })
  }

  // 3) Limite do plano: Mensal = ilimitado; Vitalício = 17 sites por mês (conta por clique em "Gerar").
  let body: any = {}
  try { body = await req.json() } catch { /* corpo inválido */ }
  const plan = sub.plan === 'vitalicio' ? 'vitalicio' : 'mensal'
  const limit = plan === 'vitalicio' ? LIFETIME_LIMIT : 0
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const svc = { apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}` }
  const usedRes = await doFetch(`${env.url}/rest/v1/site_generations?select=gen_id,created_at&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(monthStart)}`, { headers: svc })
  const usedRows = usedRes.ok ? await usedRes.json().catch(() => []) : []
  const usedIds = new Set((Array.isArray(usedRows) ? usedRows : []).map((r: any) => String(r.gen_id)))
  // Um mesmo genId só pode ser repetido (nova tentativa da mesma criação) por 15 minutos.
  const recentIds = new Set((Array.isArray(usedRows) ? usedRows : []).filter((r: any) => Date.now() - new Date(r.created_at).getTime() < 15 * 60 * 1000).map((r: any) => String(r.gen_id)))
  const genId = String(body?.genId || '').replace(/[^\w-]/g, '').slice(0, 64)
  const quota = (used: number) => ({ plan, used, limit })
  if (body?.mode === 'quota') return json(200, { quota: quota(usedIds.size) })
  if (body?.mode === 'photo') {
    const imgBlock = await rateCheck(env, doFetch, [
      ['img:min:' + email, 60, 15, '1 minuto'],
      ['img:hour:' + email, 3600, 60, 'alguns minutos'],
      ['img:day:' + email, 86400, 80, 'até amanhã'],
    ])
    if (imgBlock) return imgBlock
    if (limit && usedIds.size >= limit && !(genId && recentIds.has(genId))) {
      return json(429, { error: `Você já usou as ${limit} criações de site deste mês do plano Vitalício.`, quota: quota(usedIds.size) })
    }
    const shot = SHOTS[String(body?.shot)] ? String(body.shot) : 'hero'
    const pPrompt = photoPrompt(shot, body?.nicho, body?.cidade, body?.estilo)
    try {
      const t0 = Date.now()
      const image = await genImage(env, doFetch, pPrompt, SHOTS[shot].aspect)
      console.log('foto IA', JSON.stringify({ email, shot, ms: Date.now() - t0, kb: Math.round(image.length / 1024) }))
      return json(200, { image, shot })
    } catch (e) {
      return json(502, { error: 'Não consegui criar a foto agora. Tente de novo.' })
    }
  }
  // Limite de velocidade por conta (vale para os dois planos): protege o saldo da IA contra abuso.
  const userBlock = await rateCheck(env, doFetch, [
    ['gen:min:' + email, 60, 6, '1 minuto'],
    ['gen:hour:' + email, 3600, 40, 'alguns minutos'],
    ['gen:day:' + email, 86400, 150, 'até amanhã'],
  ])
  if (userBlock) return userBlock
  if (limit && usedIds.size >= limit && !(genId && recentIds.has(genId))) {
    return json(429, { error: `Você já usou as ${limit} criações de site deste mês do plano Vitalício. Novas criações liberam no dia 1º do próximo mês. Para criar sites ilimitados, use o plano Mensal.`, quota: quota(usedIds.size) })
  }
  const record = async () => {
    const id = genId || crypto.randomUUID()
    if (usedIds.has(id)) return usedIds.size
    const r = await doFetch(`${env.url}/rest/v1/site_generations?on_conflict=email,gen_id`, {
      method: 'POST',
      headers: { ...svc, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ email, gen_id: id }),
    })
    if (!r.ok) console.error('site_generations', r.status, await r.text().catch(() => ''))
    return usedIds.size + 1
  }

  // 4) Prompt
  const prompt = String(body?.prompt || '').trim()
  if (prompt.length < 20) return json(400, { error: 'Prompt vazio. Escolha um nicho e tente de novo.' })
  if (prompt.length > MAX_PROMPT) return json(400, { error: 'Prompt grande demais.' })

  const contentMode = body?.mode === 'content'

  // 4) Chama a IA (no modo conteúdo, com pesquisa na internet sobre o nicho)
  const started = Date.now()
  const research = contentMode && !!body?.research
  const callAI = (withWeb: boolean) => doFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.openrouterKey}`,
      'content-type': 'application/json',
      'http-referer': 'https://digital-one-zeta.vercel.app',
      'x-title': 'Sora',
    },
    body: JSON.stringify(contentMode ? {
      model: MODEL,
      max_tokens: 9000,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      ...(withWeb ? { plugins: [{ id: 'web', max_results: 5 }] } : {}),
      messages: [
        { role: 'system', content: SYSTEM_CONTENT },
        { role: 'user', content: prompt },
      ],
    } : {
      model: MODEL,
      max_tokens: 16000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: BRIEF + prompt },
      ],
    }),
  })
  let aiRes = await callAI(research)
  if (!aiRes.ok && research) {
    console.error('gerar-site pesquisa falhou', aiRes.status, (await aiRes.text().catch(() => '')).slice(0, 300))
    aiRes = await callAI(false) // sem pesquisa, mas o site sai do mesmo jeito
  }
  const ai = await aiRes.json().catch(() => ({}))
  if (!aiRes.ok) {
    console.error('OpenRouter erro', aiRes.status, JSON.stringify(ai).slice(0, 500))
    const msg = aiRes.status === 402 || aiRes.status === 403
      ? 'O saldo da IA acabou. Avise o suporte do Sora.'
      : 'A IA não respondeu agora. Tente de novo em alguns segundos.'
    return json(502, { error: msg })
  }
  const choice = ai?.choices?.[0] || {}
  const usage = ai?.usage || {}
  if (contentMode) {
    const content = parseContent(choice?.message?.content || '')
    if (!content) {
      console.error('gerar-site sem JSON', JSON.stringify({ email, finish: choice?.finish_reason, start: String(choice?.message?.content || '').slice(0, 300) }))
      return json(502, { error: 'A IA não devolveu o conteúdo do site. Tente de novo.' })
    }
    console.log('gerar-site content', JSON.stringify({ email, model: MODEL, ms: Date.now() - started, tokens: usage.total_tokens, cost: usage.cost }))
    return json(200, { content, model: MODEL, tokens: usage.total_tokens ?? null, quota: quota(await record()) })
  }
  const html = cleanHtml(choice?.message?.content || '')
  if (!/<html|<body|<!doctype/i.test(html)) {
    console.error('gerar-site sem HTML', JSON.stringify({ email, finish: choice?.finish_reason, start: String(choice?.message?.content || '').slice(0, 300) }))
    return json(502, { error: 'A IA não devolveu um site válido. Tente de novo.' })
  }

  console.log('gerar-site', JSON.stringify({ email, model: MODEL, ms: Date.now() - started, tokens: usage.total_tokens, cost: usage.cost }))
  return json(200, { html, model: MODEL, tokens: usage.total_tokens ?? null, quota: quota(await record()) })
}

declare const Deno: any
if (typeof Deno !== 'undefined') {
  Deno.serve((req: Request) =>
    handle(req, {
      url: Deno.env.get('SUPABASE_URL') ?? '',
      serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      openrouterKey: Deno.env.get('OPENROUTER_API_KEY') ?? '',
    }).catch((err: unknown) => {
      console.error('Erro inesperado em gerar-site:', err)
      return json(500, { error: 'Erro inesperado. Tente de novo.' })
    })
  )
}
