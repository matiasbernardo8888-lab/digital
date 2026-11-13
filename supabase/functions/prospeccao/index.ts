// Supabase Edge Function: prospeccao  (o "/api/prospeccao" do Sora)
// Radar de Empresas Sem Site: busca empresas no Google Places e devolve só as que NÃO têm site.
//
// Ações (POST JSON):
//   { action: 'search', country: 'ES', city: 'Madrid', niche: 'barbearia' | 'todos' }
//   { action: 'cities', country: 'ES', q: 'Mad' }            -> autocomplete de cidades
//
// Segurança: só aceita usuários logados no Sora com assinatura ativa (tabela subscriptions).
// Chave do Google: Secret GOOGLE_PLACES_API_KEY (Edge Functions > Secrets). Nunca vai para o navegador.
// SEM a chave, busca empresas reais no OpenStreetMap (grátis, dados menos completos que o Google).

type Env = { url: string; serviceKey: string; anonKey: string; placesKey: string; geoKey?: string }

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

// País -> idioma da busca, região e nome usado no texto da busca.
export const COUNTRIES: Record<string, { lang: string; name: string }> = {
  BR: { lang: 'pt-BR', name: 'Brasil' },
  PT: { lang: 'pt-PT', name: 'Portugal' },
  ES: { lang: 'es', name: 'España' },
  MX: { lang: 'es', name: 'México' },
  AR: { lang: 'es', name: 'Argentina' },
  US: { lang: 'en', name: 'USA' },
  GB: { lang: 'en', name: 'United Kingdom' },
  FR: { lang: 'fr', name: 'France' },
  IT: { lang: 'it', name: 'Italia' },
  DE: { lang: 'de', name: 'Deutschland' },
  NL: { lang: 'nl', name: 'Nederland' },
  BE: { lang: 'fr', name: 'Belgique' },
  CH: { lang: 'de', name: 'Schweiz' },
  AT: { lang: 'de', name: 'Österreich' },
  IE: { lang: 'en', name: 'Ireland' },
  LU: { lang: 'fr', name: 'Luxembourg' },
  CA: { lang: 'en', name: 'Canada' },
  AU: { lang: 'en', name: 'Australia' },
  CL: { lang: 'es', name: 'Chile' },
  CO: { lang: 'es', name: 'Colombia' },
  UY: { lang: 'es', name: 'Uruguay' },
  PE: { lang: 'es', name: 'Perú' },
}

// Nicho -> termo de busca em cada idioma.
export const NICHES: Record<string, Record<string, string>> = {
  barbearia: { pt: 'barbearia', es: 'barbería', en: 'barbershop', fr: 'barbier', it: 'barbiere', de: 'Barbershop' },
  restaurante: { pt: 'restaurante', es: 'restaurante', en: 'restaurant', fr: 'restaurant', it: 'ristorante', de: 'Restaurant' },
  dentista: { pt: 'clínica odontológica', es: 'clínica dental', en: 'dental clinic', fr: 'cabinet dentaire', it: 'studio dentistico', de: 'Zahnarztpraxis' },
  oficina: { pt: 'oficina mecânica', es: 'taller mecánico', en: 'auto repair shop', fr: 'garage automobile', it: 'officina meccanica', de: 'Autowerkstatt' },
  academia: { pt: 'academia', es: 'gimnasio', en: 'gym', fr: 'salle de sport', it: 'palestra', de: 'Fitnessstudio' },
  salao: { pt: 'salão de beleza', es: 'salón de belleza', en: 'beauty salon', fr: 'salon de beauté', it: 'salone di bellezza', de: 'Schönheitssalon' },
  advogado: { pt: 'advogado', es: 'abogado', en: 'lawyer', fr: 'avocat', it: 'avvocato', de: 'Rechtsanwalt' },
}

// Cidades de exemplo (usadas no autocomplete quando não há chave do Google).
const SAMPLE_CITIES: Record<string, string[]> = {
  BR: ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Capelinha', 'Curitiba', 'Porto Alegre', 'Salvador', 'Fortaleza', 'Recife', 'Brasília', 'Florianópolis', 'Goiânia'],
  PT: ['Lisboa', 'Porto', 'Braga', 'Coimbra', 'Faro', 'Aveiro', 'Setúbal', 'Funchal', 'Évora', 'Viseu'],
  ES: ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Málaga', 'Bilbao', 'Zaragoza', 'Alicante', 'Granada', 'Palma'],
  MX: ['Ciudad de México', 'Guadalajara', 'Monterrey', 'Puebla', 'Cancún', 'Tijuana', 'Mérida', 'Querétaro'],
  AR: ['Buenos Aires', 'Córdoba', 'Rosario', 'Mendoza', 'La Plata', 'Mar del Plata'],
  US: ['New York', 'Miami', 'Orlando', 'Boston', 'Los Angeles', 'Houston', 'Chicago', 'Newark'],
  GB: ['London', 'Manchester', 'Birmingham', 'Liverpool', 'Leeds', 'Edinburgh'],
  FR: ['Paris', 'Lyon', 'Marseille', 'Nice', 'Toulouse', 'Bordeaux'],
  IT: ['Roma', 'Milano', 'Napoli', 'Torino', 'Firenze', 'Bologna'],
  DE: ['Berlin', 'München', 'Hamburg', 'Frankfurt', 'Köln', 'Stuttgart'],
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Muitas empresas sem site colocam a rede social no campo "site" do Google. Isso NÃO é site: vira contato.
const SOCIAL: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/i, 'instagram'], [/(^|\.)instagr\.am$/i, 'instagram'],
  [/(^|\.)(facebook|fb)\.com$/i, 'facebook'], [/(^|\.)fb\.me$/i, 'facebook'],
  [/(^|\.)(wa\.me|whatsapp\.com)$/i, 'whatsapp'], [/(^|\.)linktr\.ee$/i, 'linktree'],
  [/(^|\.)tiktok\.com$/i, 'tiktok'],
]
export function socialKind(url: string): string | null {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname
    for (const [re, kind] of SOCIAL) if (re.test(host)) return kind
  } catch { /* url inválida */ }
  return null
}
export function contactsFor(phone: string, social: string) {
  const digits = String(phone || '').replace(/\D/g, '')
  const c: Record<string, string> = {}
  if (phone) { c.phone = phone; c.tel = 'tel:' + (/^\s*\+/.test(String(phone)) ? '+' : '') + digits }
  if (digits.length >= 8 && /^\+/.test(String(phone).trim())) c.whatsapp = 'https://wa.me/' + digits
  const kind = social ? socialKind(social) : null
  if (kind) c[kind] = /^https?:\/\//i.test(social) ? social : 'https://' + social
  return c
}

export function nicheTerm(niche: string, lang: string): string {
  const base = lang.slice(0, 2)
  return NICHES[niche]?.[base] || NICHES[niche]?.pt || niche
}

// ---------- Dados de exemplo (sem chave) ----------
export function mockLeads(city: string, country: string, niche: string) {
  const c = COUNTRIES[country] || COUNTRIES.BR
  const term = niche === 'todos' ? '' : nicheTerm(niche, c.lang)
  const names = ['Central', 'do Bairro', 'Premium', 'Família', 'Express', 'Real', 'Bella Vista', 'São Jorge', 'Estrela', 'Bom Gosto']
  const streets = ['Rua das Flores', 'Avenida Principal', 'Rua do Comércio', 'Praça Central', 'Rua Nova', 'Avenida da Liberdade', 'Rua Direita', 'Travessa do Sol', 'Rua da Paz', 'Largo do Mercado']
  const kinds = ['Barbearia', 'Restaurante', 'Clínica Odontológica', 'Oficina', 'Academia', 'Salão', 'Escritório de Advocacia']
  return names.map((n, i) => {
    const kind = term ? term.charAt(0).toUpperCase() + term.slice(1) : kinds[i % kinds.length]
    const rating = Math.round((4 + ((i * 37) % 10) / 10) * 10) / 10
    return {
      id: `mock-${country}-${i}`,
      name: `${kind} ${n} (exemplo)`,
      address: `${streets[i]}, ${100 + i * 17} - ${city}, ${c.name}`,
      rating,
      reviews: 20 + ((i * 53) % 280),
      phone: i % 4 === 3 ? '' : `+00 000 000 ${String(100 + i).padStart(3, '0')}`,
      contacts: contactsFor(i % 4 === 3 ? '' : `+00 000 000 ${String(100 + i).padStart(3, '0')}`, i % 3 === 0 ? `https://www.instagram.com/exemplo_${i}` : i === 4 ? 'https://facebook.com/exemplo4' : ''),
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${kind} ${n} ${city}`)}`,
      niche: niche === 'todos' ? kinds[i % kinds.length].toLowerCase() : niche,
    }
  })
}

// ---------- Google Places API (New) ----------
// Usa só a Text Search: com o field mask abaixo ela já devolve website, telefone, nota e avaliações,
// então não precisa chamar o Place Details para cada empresa (fica 1 chamada em vez de 21).
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating', 'places.userRatingCount',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.websiteUri', 'places.googleMapsUri',
  'places.businessStatus',
].join(',')

async function textSearch(key: string, query: string, lang: string, region: string, doFetch: typeof fetch) {
  const res = await doFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': FIELDS },
    body: JSON.stringify({ textQuery: query, languageCode: lang, regionCode: region, pageSize: 20 }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google Places ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
  return (data.places || []) as any[]
}

/*  Alternativa "clássica" (Text Search + Place Details por empresa), caso prefira a API legada:

    const ts = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=${lang}&region=${region.toLowerCase()}&key=${key}`).then(r => r.json())
    for (const p of ts.results.slice(0, 20)) {
      const det = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,url&language=${lang}&key=${key}`).then(r => r.json())
      if (!det.result?.website) leads.push(det.result)   // sem site = lead quente
    }
*/

export async function realLeads(key: string, city: string, country: string, niche: string, doFetch: typeof fetch, term = '') {
  const c = COUNTRIES[country] || COUNTRIES.BR
  const niches = niche === 'custom' ? ['custom'] : niche === 'todos' ? Object.keys(NICHES) : [niche]
  const conn = c.lang.startsWith('en') ? 'in' : c.lang.startsWith('pt') ? 'em' : c.lang.startsWith('es') ? 'en' : c.lang.startsWith('fr') ? 'à' : c.lang.startsWith('it') ? 'a' : 'in'
  const batches = await Promise.all(niches.map(async (n) => {
    const places = await textSearch(key, `${n === 'custom' ? term : nicheTerm(n, c.lang)} ${conn} ${city}, ${c.name}`, c.lang, country, doFetch)
    return places.map((p) => ({ p, n }))
  }))
  const seen = new Set<string>()
  const analyzed = batches.reduce((t, b) => t + b.length, 0)
  const leads = []
  for (const { p, n } of batches.flat()) {
    if (!p?.id || seen.has(p.id)) continue
    seen.add(p.id)
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue
    const site = String(p.websiteUri || '').trim()
    if (site && !socialKind(site)) continue // TEM site de verdade: descarta (rede social não conta como site)
    leads.push({
      id: p.id,
      name: p.displayName?.text || 'Sem nome',
      address: p.formattedAddress || '',
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviews: p.userRatingCount || 0,
      phone: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
      contacts: contactsFor(p.internationalPhoneNumber || p.nationalPhoneNumber || '', site),
      mapsUrl: p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      niche: n,
    })
  }
  leads.sort((a, b) => (b.reviews || 0) - (a.reviews || 0))
  return { leads, analyzed }
}

// ---------- OpenStreetMap (grátis, sem chave) ----------
// Usado quando NÃO há GOOGLE_PLACES_API_KEY. Nominatim acha a cidade, Overpass lista as empresas.
const UA = 'SoraRadar/1.0 (+https://digital-one-zeta.vercel.app)'
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']

// Nicho -> filtros do OpenStreetMap.
export const OSM_TAGS: Record<string, string[]> = {
  barbearia: ['["shop"~"^(hairdresser|barber)$"]'],
  restaurante: ['["amenity"="restaurant"]'],
  dentista: ['["amenity"="dentist"]', '["healthcare"="dentist"]'],
  oficina: ['["shop"="car_repair"]', '["craft"="car_repair"]'],
  academia: ['["leisure"="fitness_centre"]'],
  salao: ['["shop"~"^(beauty|hairdresser|nails|cosmetics)$"]'],
  advogado: ['["office"="lawyer"]'],
}
// Nichos dos cards (texto livre, em qualquer idioma) -> filtros.
const OSM_WORDS: [RegExp, string[]][] = [
  [/barb|cabele|peluq|coiff|friseur|parrucch|hair|salao|salon/, ['["shop"~"^(hairdresser|barber|beauty)$"]']],
  [/restaur|ristorant|comida|food|pizz|cafe|bar\b/, ['["amenity"~"^(restaurant|cafe|fast_food)$"]']],
  [/dent|odont|zahn|estetic|aesthetic|beaut|bellez|beaute|kosmet/, ['["amenity"="dentist"]', '["shop"="beauty"]', '["healthcare"="dentist"]']],
  [/advog|abogad|lawyer|avocat|anwalt|avvocat|imigra|inmigra|immigra/, ['["office"~"^(lawyer|notary)$"]']],
  [/contad|contab|account|comptab|steuer|commercialist|fiscal/, ['["office"~"^(accountant|tax_advisor)$"]']],
  [/psic|psych|\bterap|\btherap/, ['["healthcare"~"^(psychotherapist|counselling)$"]', '["office"="psychologist"]']],
  [/idioma|language|lingu|sprach|langue/, ['["amenity"="language_school"]']],
  [/imobil|inmobil|real estate|immobil|estate/, ['["office"="estate_agent"]']],
  [/oficina|taller|garage|werkstatt|officina|mecan|auto(?!escu|escol|-ecol|scuol)/, ['["shop"="car_repair"]', '["craft"="car_repair"]']],
  [/academia|gym|gimnas|fitness|palestra|personal|\bsport/, ['["leisure"="fitness_centre"]']],
  [/arquit|architect|interior|design/, ['["office"="architect"]', '["craft"="interior_decorator"]']],
  [/veterin|tierarzt/, ['["amenity"="veterinary"]']],
  [/limpez|limpie|clean|nettoy|reinig|pulizi/, ['["craft"="cleaning"]', '["office"="cleaning"]', '["shop"="dry_cleaning"]']],
  [/constru|reforma|builder|renov|bau|edil/, ['["craft"~"^(builder|carpenter|plumber|electrician|painter)$"]', '["office"="construction_company"]']],
  [/roupa|boutique|cloth|\bropa|vetement|kleid|abbigli|moda|fashion/, ['["shop"~"^(clothes|boutique|fashion)$"]']],
  [/fotog|photog|video|fotograf/, ['["craft"="photographer"]', '["shop"="photo"]']],
  [/despach|document|gestor|consult|tramit/, ['["office"~"^(consulting|administrative|company)$"]']],
  [/nutri|ernahr|dietist/, ['["healthcare"="nutrition_counselling"]', '["healthcare:speciality"="nutrition"]']],
  [/pet|animal|mascot|haustier/, ['["shop"="pet"]', '["shop"="pet_grooming"]']],
  [/igrej|church|iglesia|eglise|kirche|chiesa|comunidad|community/, ['["amenity"="place_of_worship"]']],
  [/fisio|physio|kine|quiro|chiro/, ['["healthcare"~"^(physiotherapist|chiropractor)$"]', '["healthcare:speciality"~"physiotherapy|chiropractic"]']],
  [/tatu|tattoo|tatou/, ['["shop"="tattoo"]']],
  [/flor|fleur|blume|fiori/, ['["shop"="florist"]']],
  [/bake|panad|panif|padar|boulang|backer|baecker|confeit|pastel|pastic|pastry|patiss|kondit/, ['["shop"~"^(bakery|pastry|confectionery)$"]']],
  [/music|musik|musiq|\bdanc|danz|danse|tanz|baile/, ['["amenity"~"^(music_school|dancing_school)$"]', '["leisure"="dance"]']],
  [/eletric|electric|elektrik|elettric|encanad|plumb|plomb|fontaner|klempner|idraul/, ['["craft"~"^(electrician|plumber|hvac)$"]']],
  [/mudan|moving|demenag|umzug|trasloc/, ['["office"="moving_company"]', '["shop"="moving"]']],
  [/massag|masaj|\bspa\b|spas/, ['["shop"="massage"]', '["leisure"="spa"]', '["amenity"="spa"]']],
  [/alojam|pousada|guest|holiday|rural|chambre|gite|pension|ferienw|vacanz|b&b|hostel|hotel/, ['["tourism"~"^(guest_house|hostel|apartment|chalet|motel)$"]']],
  [/driving|autoescu|autoescol|auto-ecol|auto ecol|fahrschul|autoscuol/, ['["amenity"="driving_school"]']],
]
export function osmFilters(niche: string, term = ''): string[] {
  if (niche === 'todos') return Object.values(OSM_TAGS).flat()
  if (niche !== 'custom') return OSM_TAGS[niche] || []
  const t = norm(term)
  const out: string[] = []
  for (const [re, f] of OSM_WORDS) if (re.test(t)) out.push(...f)
  return Array.from(new Set(out))
}
function osmNiche(tags: Record<string, string>, niche: string): string {
  if (niche !== 'todos') return niche
  for (const [id, fs] of Object.entries(OSM_TAGS)) {
    for (const f of fs) {
      const m = /\["([^"]+)"[=~]"\^?\(?([^"$)]+)/.exec(f)
      if (m && tags[m[1]] && m[2].split('|').includes(tags[m[1]])) return id
    }
  }
  return 'todos'
}
async function fetchT(doFetch: typeof fetch, url: string, init: RequestInit = {}, ms = 25000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
  try { return await doFetch(url, { ...init, signal: ctl.signal }) } finally { clearTimeout(t) }
}
async function overpass(q: string, doFetch: typeof fetch, ms = 28000) {
  let lastErr = ''
  for (const url of OVERPASS) {
    try {
      const r = await fetchT(doFetch, url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: 'data=' + encodeURIComponent(q) }, ms)
      if (r.ok) return await r.json()
      lastErr = `Overpass ${r.status}`
    } catch (e) { lastErr = String(e) }
  }
  throw new Error(lastErr || 'Overpass sem resposta')
}
const ADMIN_PREF = ['8', '7', '9', '6', '10', '5', '4']
export async function osmCityArea(city: string, country: string, doFetch: typeof fetch): Promise<string> {
  // 1) Photon (geocoder gratuito feito sobre o OpenStreetMap): rápido e aceita nome sem acento.
  try {
    const r = await fetchT(doFetch, `https://photon.komoot.io/api/?q=${encodeURIComponent(city)}&limit=10&layer=city&layer=county&layer=state&layer=district`, { headers: { 'user-agent': UA } }, 10000)
    if (!r.ok) console.error('photon', r.status)
    const d = r.ok ? await r.json().catch(() => ({})) : {}
    const feats = ((d as any).features || []).map((f: any) => f.properties || {})
      .filter((p: any) => String(p.countrycode || '').toUpperCase() === country && p.osm_type === 'R')
    const rank = (p: any) => { const t = String(p.type || p.osm_value || ''); return t === 'city' ? 0 : t === 'town' ? 1 : t === 'district' ? 2 : t === 'county' ? 3 : 4 }
    feats.sort((x: any, y: any) => rank(x) - rank(y))
    if (feats[0]) return `area(${3600000000 + Number(feats[0].osm_id)})->.a;`
  } catch (e) { console.error('osm cidade photon', String(e)) }
  // 2) Overpass pelo nome exato (como digitado e com iniciais maiúsculas).
  const names = Array.from(new Set([city, city.replace(/(^|[\s-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())])).map((n) => n.replace(/"/g, ''))
  try {
    const d = await overpass(`[out:json][timeout:15];(${names.map((n) => `rel["boundary"="administrative"]["name"="${n}"];`).join('')});out tags;`, doFetch, 18000)
    const rels = (((d && d.elements) || []) as any[]).filter((e) => !e.tags?.['ISO3166-2'] || String(e.tags['ISO3166-2']).startsWith(country))
    rels.sort((a, b) => {
      const ia = ADMIN_PREF.indexOf(String(a.tags?.admin_level)), ib = ADMIN_PREF.indexOf(String(b.tags?.admin_level))
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    if (rels[0]) return `area(${3600000000 + Number(rels[0].id)})->.a;`
  } catch (e) { console.error('osm cidade overpass', String(e)) }
  return ''
}
export async function osmLeads(city: string, country: string, niche: string, doFetch: typeof fetch, term = '') {
  const filters = osmFilters(niche, term)
  if (!filters.length) return { leads: [], analyzed: 0, noFilter: true }
  // 1) Cidade -> área no mapa (primeiro pelo próprio Overpass; se não achar, tenta o Nominatim)
  const scope = await osmCityArea(city, country, doFetch)
  if (!scope) return { leads: [], analyzed: 0, noCity: true }
  const where = '(area.a)'
  const body = `[out:json][timeout:25];${scope}(${filters.map((f) => `nwr${f}["name"]${where};`).join('')});out center tags 400;`
  // 2) Empresas (tenta 2 servidores)
  const data: any = await overpass(body, doFetch)
  const els = (data.elements || []) as any[]
  return buildOsmLeads(els, city, niche)
}

const MAX_LEADS = 300

// Transforma elementos com tags do OpenStreetMap em leads (usado pelo Overpass e pela Geoapify).
export function buildOsmLeads(els: any[], city: string, niche: string) {
  const leads = []
  for (const el of els) {
    const t = el.tags || {}
    if (!t.name) continue
    if (t['brand:wikidata'] || t.brand) continue // rede/franquia: quase sempre tem site
    if (t.disused || t['disused:shop'] || t.opening_hours === 'closed') continue
    const sites = [t.website, t['contact:website'], t.url].filter(Boolean)
    const social: [string, string][] = ([
      ['instagram', t['contact:instagram'] || t.instagram], ['facebook', t['contact:facebook'] || t.facebook], ['tiktok', t['contact:tiktok'] || t.tiktok],
      ['linkedin', t['contact:linkedin'] || t.linkedin], ['youtube', t['contact:youtube'] || t.youtube], ['twitter', t['contact:twitter'] || t['contact:x'] || t.twitter],
    ] as [string, string][]).filter((x) => x[1])
    const realSite = sites.find((u: string) => !socialKind(u))
    if (realSite) continue // TEM site: descarta
    const phone = t.phone || t['contact:phone'] || t['contact:mobile'] || t.mobile || ''
    const firstPhone = String(phone).split(';')[0].trim()
    const c = contactsFor(firstPhone, sites[0] || '')
    for (const [k, sv] of social) c[k] = /^https?:\/\//i.test(sv) ? sv : /\./.test(sv) ? 'https://' + sv : `https://www.${k}.com/${String(sv).replace(/^@/, '')}`
    if (t['contact:whatsapp']) { const d = String(t['contact:whatsapp']).replace(/\D/g, ''); if (d.length >= 8) c.whatsapp = 'https://wa.me/' + d }
    const mail = String(t.email || t['contact:email'] || '').split(/[;,\s]+/).find((m: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(m))
    if (mail) c.email = 'mailto:' + mail
    const mob = String(t['contact:mobile'] || t.mobile || '').split(';')[0].trim()
    if (mob && mob !== firstPhone) {
      c.mobile = mob
      const md = mob.replace(/\D/g, '')
      if (!c.whatsapp && md.length >= 8 && /^\+/.test(mob)) c.whatsapp = 'https://wa.me/' + md
    }
    const tg = String(t['contact:telegram'] || t.telegram || '').trim()
    if (tg) c.telegram = /^https?:\/\//i.test(tg) ? tg : 'https://t.me/' + tg.replace(/^@/, '')
    const addr = [[t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', '), t['addr:postcode'], t['addr:city'] || city].filter(Boolean).join(' - ')
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon
    leads.push({
      id: `osm-${el.type}-${el.id}`,
      name: t.name,
      address: addr || city,
      rating: null,
      reviews: null,
      phone: firstPhone,
      contacts: c,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${t.name} ${addr || city}`)}`,
      osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      lat, lon,
      niche: niche === 'custom' ? 'custom' : osmNiche(t, niche),
      score: (el.region ? 0 : 10) + (firstPhone ? 4 : 0) + (social.length ? 2 : 0) + (t['addr:street'] ? 1 : 0),
    })
  }
  leads.sort((a, b) => b.score - a.score)
  return { leads: leads.slice(0, MAX_LEADS).map(({ score, ...l }) => l), analyzed: els.length }
}

// ---------- Geoapify (grátis, sem cartão; dados do OpenStreetMap) ----------
// Secret GEOAPIFY_API_KEY. Usado quando não há chave do Google.
const GEO = 'https://api.geoapify.com'
// Filtro do OSM -> categorias da Geoapify. Pais genéricos (office, healthcare...) entram com o filtro de tags depois.
const GEO_CATS: [RegExp, string[]][] = [
  [/hairdresser|barber/, ['service.beauty.hairdresser', 'service.beauty']],
  [/"beauty|nails|cosmetics/, ['service.beauty']],
  [/restaurant/, ['catering.restaurant']],
  [/cafe|fast_food/, ['catering.cafe', 'catering.fast_food']],
  [/dentist/, ['healthcare.dentist']],
  [/car_repair/, ['service.vehicle.repair', 'service.vehicle']],
  [/fitness_centre/, ['sport.fitness']],
  [/lawyer|notary/, ['office.lawyer', 'office.notary', 'office']],
  [/accountant|tax_advisor/, ['office.accountant', 'office.tax_advisor', 'office']],
  [/psychotherapist|counselling|psychologist|nutrition/, ['healthcare', 'office']],
  [/language_school/, ['education.language_school', 'education']],
  [/estate_agent/, ['office.estate_agent', 'office']],
  [/architect|interior_decorator/, ['office.architect', 'office', 'service']],
  [/veterinary/, ['pet.veterinary', 'pet']],
  [/cleaning|dry_cleaning/, ['service.cleaning', 'service', 'office']],
  [/builder|carpenter|plumber|electrician|painter|construction_company/, ['office', 'service', 'production']],
  [/clothes|boutique|fashion/, ['commercial.clothing', 'commercial']],
  [/photographer|"photo"/, ['service', 'commercial']],
  [/consulting|administrative|company/, ['office']],
  [/"pet"|pet_grooming/, ['pet.shop', 'pet.service', 'pet']],
  [/place_of_worship/, ['religion.place_of_worship', 'religion']],
  [/physiotherapist|chiropractor|physiotherapy/, ['healthcare']],
  [/tattoo/, ['service', 'commercial']],
  [/florist/, ['commercial.florist', 'commercial']],
  [/bakery|pastry|confectionery/, ['commercial.food_and_drink', 'catering', 'commercial']],
  [/music_school|dancing_school|"dance"/, ['education', 'entertainment', 'leisure']],
  [/hvac/, ['service', 'production']],
  [/moving_company|"moving"/, ['office', 'service', 'commercial']],
  [/massage|"spa"/, ['service.beauty', 'leisure', 'service']],
  [/guest_house|hostel|apartment|chalet|motel/, ['accommodation']],
  [/driving_school/, ['education']],
]
function geoCatsFor(filters: string[]): string[] {
  const out: string[] = []
  for (const f of filters) for (const [re, cats] of GEO_CATS) if (re.test(f)) out.push(...cats)
  return Array.from(new Set(out))
}
function tagMatch(tags: Record<string, any>, f: string): boolean {
  const m = /^\["([^"]+)"(=|~)"([^"]*)"\]$/.exec(f)
  if (!m) return false
  const v = tags[m[1]]
  if (v == null) return false
  return m[2] === '=' ? String(v) === m[3] : new RegExp(m[3]).test(String(v))
}
async function geoGet(key: string, path: string, params: Record<string, string>, doFetch: typeof fetch) {
  const qs = new URLSearchParams({ ...params, apiKey: key }).toString()
  const r = await fetchT(doFetch, `${GEO}${path}?${qs}`, {}, 20000)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Geoapify ${r.status}: ${JSON.stringify(data).slice(0, 200)}`)
  return data
}
async function geoCity(key: string, city: string, country: string, doFetch: typeof fetch): Promise<{ id: string, lat: number, lon: number }> {
  const c = COUNTRIES[country] || COUNTRIES.BR
  for (const type of ['city', '']) {
    const p: Record<string, string> = { text: city, filter: `countrycode:${country.toLowerCase()}`, lang: c.lang.slice(0, 2), limit: '1', format: 'json' }
    if (type) p.type = type
    const d: any = await geoGet(key, '/v1/geocode/search', p, doFetch)
    const r0 = d?.results?.[0]
    if (r0?.place_id) return { id: r0.place_id, lat: r0.lat, lon: r0.lon }
  }
  return { id: '', lat: 0, lon: 0 }
}
export async function geoLeads(key: string, city: string, country: string, niche: string, doFetch: typeof fetch, term = '') {
  const filters = osmFilters(niche, term)
  if (!filters.length) return { leads: [], analyzed: 0, noFilter: true }
  const place = await geoCity(key, city, country, doFetch)
  if (!place.id) return { leads: [], analyzed: 0, noCity: true }
  const c = COUNTRIES[country] || COUNTRIES.BR
  const cats = geoCatsFor(filters)
  const seen = new Set<string>()
  const els: any[] = []
  let ok = 0, lastErr = ''
  // Busca em páginas de 500 (até 3 por categoria) para não perder empresas em cidades grandes.
  const scan = async (filter: string, region: boolean) => {
    await Promise.all(cats.map(async (cat) => {
      for (let page = 0; page < 3; page++) {
        try {
          const d: any = await geoGet(key, '/v2/places', { categories: cat, filter, limit: '500', offset: String(page * 500), lang: c.lang.slice(0, 2) }, doFetch)
          ok++
          const feats = d.features || []
          for (const f of feats) {
            const p = f.properties || {}
            const raw = p.datasource?.raw || {}
            const uid = String(raw.osm_id || p.place_id)
            if (seen.has(uid)) continue
            const tags: Record<string, any> = { ...raw, name: raw.name || p.name }
            if (!tags['addr:street'] && p.street) tags['addr:street'] = p.street
            if (!tags['addr:housenumber'] && p.housenumber) tags['addr:housenumber'] = p.housenumber
            if (!tags['addr:postcode'] && p.postcode) tags['addr:postcode'] = p.postcode
            if (!tags['addr:city'] && p.city) tags['addr:city'] = p.city
            if (!filters.some((fl) => tagMatch(tags, fl))) continue
            seen.add(uid)
            const type = raw.osm_type === 'w' ? 'way' : raw.osm_type === 'r' ? 'relation' : 'node'
            els.push({ type, id: raw.osm_id || p.place_id, lat: p.lat, lon: p.lon, tags, region })
          }
          if (feats.length < 500) break
        } catch (e) { lastErr = String(e); break }
      }
    }))
  }
  await scan(`place:${place.id}`, false)
  // Poucos resultados dentro da cidade: amplia para a região (25 km em volta: bairros e cidades vizinhas).
  if (buildOsmLeads(els, city, niche).leads.length < 120 && place.lat && place.lon) await scan(`circle:${place.lon},${place.lat},25000`, true)
  if (!ok) throw new Error(lastErr || 'Geoapify sem resposta')
  return buildOsmLeads(els, city, niche)
}
async function geoCities(key: string, q: string, country: string, doFetch: typeof fetch) {
  const c = COUNTRIES[country] || COUNTRIES.BR
  const d: any = await geoGet(key, '/v1/geocode/autocomplete', { text: q, type: 'city', filter: `countrycode:${country.toLowerCase()}`, lang: c.lang.slice(0, 2), limit: '8', format: 'json' }, doFetch)
  const names = (d.results || []).map((x: any) => x.city || x.name).filter(Boolean)
  return Array.from(new Set(names)).slice(0, 8)
}

async function realCities(key: string, q: string, country: string, doFetch: typeof fetch) {
  const c = COUNTRIES[country] || COUNTRIES.BR
  const res = await doFetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ input: q, includedPrimaryTypes: ['(cities)'], includedRegionCodes: [country.toLowerCase()], languageCode: c.lang }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google Places ${res.status}`)
  return (data.suggestions || []).map((s: any) => s.placePrediction?.structuredFormat?.mainText?.text || s.placePrediction?.text?.text).filter(Boolean).slice(0, 8)
}

export async function handle(req: Request, env: Env, doFetch: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' })
  const ipBlock = await rateCheck(env, doFetch, [['pros:ip:' + clientIp(req), 60, 90, '1 minuto']])
  if (ipBlock) return ipBlock

  // 1) Login
  const auth = req.headers.get('authorization') || ''
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : ''
  if (!token) return json(401, { error: 'Faça login para usar o Radar.' })
  const userRes = await doFetch(`${env.url}/auth/v1/user`, { headers: { apikey: env.anonKey || env.serviceKey, authorization: `Bearer ${token}` } })
  if (!userRes.ok) return json(401, { error: 'Sessão expirada. Entre novamente.' })
  const email = String((await userRes.json())?.email || '').toLowerCase()
  if (!email) return json(401, { error: 'Sessão inválida. Entre novamente.' })

  // 2) Assinatura ativa
  const subRes = await doFetch(`${env.url}/rest/v1/subscriptions?select=status,expires_at&email=eq.${encodeURIComponent(email)}`,
    { headers: { apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}` } })
  const subs = subRes.ok ? await subRes.json() : []
  const sub = Array.isArray(subs) ? subs[0] : null
  const notExpired = !sub?.expires_at || new Date(sub.expires_at).getTime() > Date.now()
  if (!sub || sub.status !== 'active' || !notExpired) return json(403, { error: 'Sua conta não tem uma assinatura ativa do Sora.' })

  // 3) Ação
  let body: any = {}
  try { body = await req.json() } catch { /* vazio */ }
  const country = String(body.country || 'BR').toUpperCase()
  if (!COUNTRIES[country]) return json(400, { error: 'País não suportado.' })

  const rl = await rateCheck(env, doFetch, body.action === 'cities'
    ? [['pros:cities:' + email, 60, 60, '1 minuto']]
    : [['pros:min:' + email, 60, 10, '1 minuto'], ['pros:hour:' + email, 3600, 80, 'alguns minutos'], ['pros:day:' + email, 86400, 400, 'até amanhã']])
  if (rl) return rl

  if (body.action === 'cities') {
    const q = String(body.q || '').trim().slice(0, 60)
    if (q.length < 2) return json(200, { cities: [] })
    if (!env.placesKey && env.geoKey) {
      try { return json(200, { cities: await geoCities(env.geoKey, q, country, doFetch) }) }
      catch (e) { console.error('cities geo', String(e)) }
    }
    if (!env.placesKey) {
      const nq = norm(q)
      return json(200, { mock: true, cities: (SAMPLE_CITIES[country] || []).filter((c) => norm(c).includes(nq)).slice(0, 8) })
    }
    try { return json(200, { cities: await realCities(env.placesKey, q, country, doFetch) }) }
    catch (e) { console.error('cities', String(e)); return json(200, { cities: [] }) }
  }

  const city = String(body.city || '').trim().slice(0, 80)
  const niche = String(body.niche || '').trim()
  if (city.length < 2) return json(400, { error: 'Digite a cidade.' })
  const term = String(body.term || '').trim().slice(0, 80)
  if (niche === 'custom' ? term.length < 2 : (niche !== 'todos' && !NICHES[niche])) return json(400, { error: 'Escolha um nicho.' })

  if (!env.placesKey && env.geoKey) {
    // Sem chave do Google: Geoapify (grátis, dados do OpenStreetMap).
    try {
      const r: any = await geoLeads(env.geoKey, city, country, niche, doFetch, term)
      if (r.noCity) return json(404, { error: `Não achei a cidade "${city}" nesse país. Confira o nome.` })
      console.log('prospeccao geo', JSON.stringify({ email, country, city, niche, term, analyzed: r.analyzed, semSite: r.leads.length }))
      return json(200, { mock: false, source: 'osm', analyzed: r.analyzed, leads: r.leads })
    } catch (e) {
      console.error('prospeccao geo erro', String(e))
      return json(502, { error: 'A busca de empresas não respondeu agora. Tente de novo em alguns segundos.' })
    }
  }
  if (!env.placesKey) {
    // Sem nenhuma chave: só exemplos (o Overpass público não responde de forma confiável).
    return json(200, { mock: true, analyzed: 10, leads: mockLeads(city, country, niche) })
  }
  if (!env.placesKey) {
    // (desativado) busca direta no Overpass do OpenStreetMap.
    try {
      const r: any = await osmLeads(city, country, niche, doFetch, term)
      if (r.noCity) return json(404, { error: `Não achei a cidade "${city}" nesse país. Confira o nome.` })
      console.log('prospeccao osm', JSON.stringify({ email, country, city, niche, term, analyzed: r.analyzed, semSite: r.leads.length }))
      return json(200, { mock: false, source: 'osm', analyzed: r.analyzed, leads: r.leads })
    } catch (e) {
      console.error('prospeccao osm erro', String(e))
      return json(502, { error: 'O mapa não respondeu agora (servidor ocupado). Tente de novo em alguns segundos.' })
    }
  }
  try {
    const { leads, analyzed } = await realLeads(env.placesKey, city, country, niche, doFetch, term)
    console.log('prospeccao', JSON.stringify({ email, country, city, niche, analyzed, semSite: leads.length }))
    return json(200, { mock: false, analyzed, leads })
  } catch (e) {
    console.error('prospeccao erro', String(e))
    return json(502, { error: 'O Google não respondeu agora. Confira a chave da API e tente de novo.' })
  }
}

declare const Deno: any
if (typeof Deno !== 'undefined') {
  Deno.serve((req: Request) =>
    handle(req, {
      url: Deno.env.get('SUPABASE_URL') ?? '',
      serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      placesKey: Deno.env.get('GOOGLE_PLACES_API_KEY') ?? '',
      geoKey: Deno.env.get('GEOAPIFY_API_KEY') ?? '',
    }).catch((err: unknown) => {
      console.error('Erro inesperado em prospeccao:', err)
      return json(500, { error: 'Erro inesperado. Tente de novo.' })
    })
  )
}
