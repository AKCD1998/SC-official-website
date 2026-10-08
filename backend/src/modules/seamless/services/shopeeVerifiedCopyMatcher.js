const crypto = require('node:crypto');
const rules = require('../data/shopeeAdaSmartCopyRules.v1.json');
const catalog = require('../data/shopeeProductCatalog.v1.json');
const { buildAutomaticQuantityRules, extractPackagingQuantities } = require('./shopeeAutomaticQuantityRules');

const VERIFIED_COPY_MATCH_VERSION = 'verified-structural-copy-2026-10-08-v3';
const UNIT_LABELS = { box: 'กล่อง', sachet: 'ซอง', can: 'กระป๋อง', jar: 'กระปุก',
  piece: 'ชิ้น', blister: 'แผง', pack: 'แพ็ก', bar: 'ก้อน' };
const MAX_FACTOR = 1000;

// Keep numbers, +, slashes and word multiplicity. This is a formatting key,
// never edit the source name/variant or use a similarity score as evidence.
function normalizeStructuralText(value) {
  // NFC preserves Thai sara-am; normalize full-width ASCII independently.
  return String(value || '').normalize('NFC').replace(/[\uff01-\uff5e]/gu, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase()
    .replace(/[\u200b\u2060\ufeff]/gu, '')
    .replace(/[’‘]/gu, "'").replace(/[‐‑–—]/gu, '-')
    .replace(/(?:มล\.?|millilit(?:er|re)s?|ml\.)/giu, ' ml ')
    .replace(/(?:ซม\.?|centimet(?:er|re)s?|cm\.)/giu, ' cm ')
    .replace(/(?:กรัม|grams?)/giu, ' g ')
    .replace(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/giu, '$1x$2')
    .replace(/(\d)\s*(ml|cm|g)\b/giu, '$1 $2')
    .replace(/[(),:;|]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function formattingKey(value) {
  // Preserve number/unit and formula/model associations. Reordering is only
  // allowed by the typed family parsers below, never by sorting raw tokens.
  return normalizeStructuralText(value);
}
const identityKey = (shop, name, variant) => JSON.stringify([shop, formattingKey(name), formattingKey(variant)]);
const strip = (text, expression) => text.replace(expression, ' ').replace(/\s+/gu, ' ').trim();
const values = (text, expression) => [...text.matchAll(expression)].map(m => m[1]);
const unique = xs => [...new Set(xs)];
function one(xs) { const found = unique(xs); return found.length === 1 ? found[0] : null; }
function hasBundle(text) {
  return /(?:แถม|bundle|ชุดรวม|คละ|เซ็ตรวม|เครื่อง\s*\+|\s\+\s)/iu.test(text);
}

function packaging(text) {
  const quantities = {};
  let rest = text;
  const aliases = [['box', /(?:กล่อง|\bbox(?:es)?\b|\bbx\b)/gu],
    ['sachet', /(?:ซอง|\bsachets?\b)/gu], ['bottle', /(?:ขวด|\bbottles?\b)/gu],
    ['sheet', /(?:แผ่น|ชิ้น|\bsheets?\b|\bpieces?\b)/gu]];
  for (const [unit, alias] of aliases) {
    const words = alias.source;
    const counts = values(rest, new RegExp(`(\\d+)\\s*${words}`, 'gu'));
    const bare = new RegExp(words, 'gu').test(rest);
    if (counts.length && !one(counts)) return null;
    if (counts.length || bare) quantities[unit] = counts.length ? Number(one(counts)) : 1;
    rest = strip(rest, new RegExp(`(?:\\d+\\s*)?${words}`, 'gu'));
  }
  if (Object.values(quantities).some(n => !Number.isSafeInteger(n) || n < 1 || n > MAX_FACTOR)) return null;
  return { quantities, rest };
}

function familyFor(name) {
  if (/\bsos\s*plus\b|เอส\s*โอ\s*เอส\s*พลัส/u.test(name)) return 'sos';
  if (/\bpropoliz\b|โพรโพลิ[ซส]/u.test(name)) return 'propoliz';
  if (/\bi-?herb\b|ไอ-?เฮิร์บ|ไอเฮิร์บ/u.test(name)) return 'iherb';
  if (/\bbactigras\b|แบคติกราส/u.test(name)) return 'bactigras';
  if (/\bone\s*gerd\b|วันเกิร์ด/u.test(name)) return 'onegerd';
  if (/\bdeeday\b|ดีเดย์/u.test(name)) return 'deeday';
  if (/\bpolar\b|โพลาร์/u.test(name) && /spray|สเปรย์/u.test(name)) return 'polar';
  if (/\bmyda\b|ไมด้า/u.test(name) && /soap|สบู่/u.test(name)) return 'myda';
  if (/\byoki\b|โยคี/u.test(name) && /powder|แป้ง/u.test(name)) return 'yoki';
  return null;
}
function removeBrand(text, family) {
  const patterns = {
    sos: /\bsos\s*plus\b|เอส\s*โอ\s*เอส\s*พลัส/gu,
    propoliz: /\bpropoliz\b|โพรโพลิ[ซส]|พรอพอลิส/gu,
    iherb: /\bi-?herb\b|ไอ-?เฮิร์บ|ไอเฮิร์บ/gu,
    bactigras: /\bbactigras\b|แบคติกราส|\bsmith\+nephew\b/gu,
    onegerd: /\bone\s*gerd\b|วันเกิร์ด/gu,
    deeday: /\bdeeday\b|ดีเดย์/gu,
  };
  return strip(text, patterns[family]);
}
function mergeFacts(a, b) {
  if (!a || !b) return null;
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value == null) continue;
    if (result[key] != null && result[key] !== value) return null;
    result[key] = value;
  }
  return result;
}
function parseSize(text, unit) {
  const expression = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`, 'gu');
  const found = values(text, expression);
  if (found.length && !one(found)) return null;
  return { size: found.length ? Number(one(found)) : null, rest: strip(text, expression) };
}

function parseSosPart(text) {
  const pack = packaging(text); if (!pack) return null;
  let rest = pack.rest;
  const dims = values(rest, /(\d+(?:\.\d+)?x\d+(?:\.\d+)?)\s*cm\b/gu);
  if (dims.length && !one(dims)) return null;
  rest = strip(rest, /\d+(?:\.\d+)?x\d+(?:\.\d+)?\s*cm\b/gu);
  const models = values(rest, /(?:^|\s)(t1-?b|s1-?b|t[1-4]|s[23]|s|m|t)(?=\s|$)/gu).map(v => v.replace('-', ''));
  if (models.length && !one(models)) return null;
  rest = strip(rest, /(?:^|\s)(?:t1-?b|s1-?b|t[1-4]|s[23]|s|m|t)(?=\s|$)/gu);
  if (rest) return null;
  return { model: one(models), dimensions: one(dims), ...pack.quantities };
}
function sosProfile(name, variant, knownTitle) {
  const hints = [];
  if (/s\s*series|รุ่น\s*s\b|เอส\s*ซีรีส์|สีน้ำเงิน|\bblue\b/u.test(name)) hints.push('s');
  if (/t\s*series|รุ่น\s*t\b|ที\s*ซีรีส์|สีแดง|\bred\b/u.test(name)) hints.push('t');
  if (/\bsb\b|สีเนื้อ/u.test(name)) hints.push('sb');
  const series = one(hints); if (!series || series === 'sb') return null;
  let title = removeBrand(name, 'sos');
  title = strip(title, /(?:รุ่น\s*[st]\s*series|[st]\s*series|รุ่น\s*[st]\b|เอส\s*ซีรีส์|ที\s*ซีรีส์|สีน้ำเงิน|สีแดง|\bblue\b|\bred\b)/gu);
  title = strip(title, /ผ้าก๊อ[ซส]ปิดแผลแบบพร้อมใช้|ผ้าก๊อ[ซส]พร้อมใช้|พร้อมแผ่นดูดซับ|พลาสเตอร์ใสปิดแผลกันน้ำ|พลาสเตอร์กันน้ำ|แผ่นฟิล์มใส|\bwaterproof\b|\bdressing\b|เลือกรุ่นและขนาดได้|เลือกขนาดได้|และ/gu);
  const facts = knownTitle ? parseSosPart(variant) : mergeFacts(parseSosPart(title), parseSosPart(variant));
  if (!facts?.model || !facts.dimensions || facts.bottle || facts.sachet) return null;
  // A new short title must say which retail package is being sold.
  if (!knownTitle && !facts.box) return null;
  return { key: JSON.stringify(['sos', series, facts.model, facts.dimensions]),
    boxCount: facts.box || 1, sheetCount: facts.sheet || null, saleUnit: 'box' };
}

function parseSprayPart(text) {
  const pack = packaging(text); if (!pack || pack.quantities.sachet || pack.quantities.sheet) return null;
  if (pack.quantities.box && pack.quantities.bottle && pack.quantities.box !== pack.quantities.bottle) return null;
  const size = parseSize(pack.rest, 'ml'); if (!size) return null;
  let rest = size.rest;
  const formulae = [];
  const named = [['kids', /\bkids?\b|คิดส์|สำหรับเด็ก/gu], ['x', /\bx\b|เอ็กซ์/gu],
    ['krachai', /กระชาย|\bkrachai\b/gu], ['plus-extherb', /\bplus\s*extherb\b/gu],
    ['original', /\boriginal\b|สูตรดั้งเดิม/gu]];
  for (const [formula, pattern] of named) {
    if (pattern.test(rest)) formulae.push(formula);
    pattern.lastIndex = 0; rest = strip(rest, pattern);
  }
  rest = strip(rest, /\bmouth\s*spray\b|สเปรย์ช่องปาก|สเปรย์พ่นปากและคอ|สเปรย์พ่นปากคอ|สเปรย์พ่นปาก|สเปรย์พ่นคอ|มาท์สเปรย์|เมาท์สเปรย์|ปราศจากน้ำตาล|ไม่มีน้ำตาล|\boriginal\b|สูตรดั้งเดิม/gu);
  if (rest || unique(formulae).length > 1) return null;
  return { volume: size.size, formula: one(formulae),
    ...(pack.quantities.box ? { count: pack.quantities.box } : {}),
    ...(pack.quantities.bottle ? { count: pack.quantities.bottle } : {}) };
}
function sprayProfile(name, variant, knownTitle) {
  if (/lozenge|candy|chewy|wash|เม็ด|ลูกอม|น้ำยาบ้วนปาก/u.test(name)) return null;
  const title = removeBrand(name, 'propoliz');
  let facts;
  if (knownTitle) {
    facts = parseSprayPart(variant);
    // A formula-only option selects original only when it says Mouth Spray.
    if (facts && !facts.formula && /mouth\s*spray/u.test(variant)) facts.formula = 'original';
    const single = parseSprayPart(title);
    if (facts && single) facts = mergeFacts(single, facts);
  } else {
    const a = parseSprayPart(title); const b = parseSprayPart(variant);
    facts = mergeFacts(a, b);
    if (facts && !facts.formula && /mouth\s*spray|สูตรดั้งเดิม|\boriginal\b/u.test(`${title} ${variant}`)) facts.formula = 'original';
    if (!facts?.count) return null;
  }
  if (!facts?.formula || !facts.volume) return null;
  return { key: JSON.stringify(['propoliz-spray', facts.formula, facts.volume]),
    saleCount: facts.count || 1, saleUnit: 'retail-bottle' };
}

function lozengeProfile(name, variant, knownTitle, seed) {
  if (!/lozenge|เม็ดอม/u.test(name) || /spray|สเปรย์|wash|น้ำยาบ้วนปาก/u.test(name)) return null;
  const part = text => {
    // Preserve tablets per retail unit separately from units per box.
    const counts = values(text, /(\d+)\s*(?:เม็ด|\btablets?\b)/gu);
    if (counts.length && !one(counts)) return null;
    let rest = strip(text, /\d+\s*(?:เม็ด|\btablets?\b)/gu);
    const blisters = values(rest, /(\d+)\s*(?:แผง|\bblisters?\b)/gu);
    if (blisters.length && !one(blisters)) return null;
    const blister = blisters.length ? Number(one(blisters)) : /แผง|\bblisters?\b/u.test(rest) ? 1 : null;
    rest = strip(rest, /(?:\d+\s*)?(?:แผง|\bblisters?\b)/gu);
    const pack = packaging(rest); if (!pack || pack.quantities.bottle || pack.quantities.sheet) return null;
    rest = pack.rest;
    const formulae = [];
    // X must retain its explicit formula. Honey/lemon alone is original only
    // in a confirmed listing frame; it cannot identify a new X flavour.
    for (const [formula, pattern] of [
      // Remove the full Extherb name before testing the shorter Thai X token.
      ['extherb', /\bextherb\b|เอ็ก(?:ซ์|ซ)?(?:เฮิร์บ|เธิร์บ)/gu], ['x', /\bx\b|เอ็กซ์/gu],
      ['vitc', /\bvit\s*c\b|วิต\s*ซี|ส้ม/gu],
      ['lozenge', /น้ำผึ้งมะนาว|honey\s*lemon|\boriginal\b/gu],
    ]) {
      if (pattern.test(rest)) formulae.push(formula);
      pattern.lastIndex = 0; rest = strip(rest, pattern);
    }
    // Lozenge is also a category word in "Extherb Lozenge". The explicit
    // formula takes precedence; Lozenge alone retains the original profile.
    if (!formulae.length && /\blozenge\b/u.test(rest)) formulae.push('lozenge');
    rest = strip(rest, /เม็ดอม|\blozenge\b/gu);
    if (rest || unique(formulae).length > 1) return null;
    return { formula: one(formulae), tablets: counts.length ? Number(one(counts)) : null,
      ...pack.quantities, ...(blister ? { blister } : {}) };
  };
  const title = removeBrand(name, 'propoliz');
  let facts = knownTitle ? part(variant) : mergeFacts(part(title), part(variant));
  if (!facts) return null;
  if (knownTitle && !facts.tablets) {
    const titleCounts = values(name, /(\d+)\s*เม็ด/gu);
    const masterCounts = values(normalizeStructuralText(seed?.master?.name || ''), /(\d+)\s*เม็ด/gu);
    facts.tablets = Number(one(titleCounts) || one(masterCounts)) || null;
  }
  if (facts.tablets !== 8 || !facts.formula) return null;
  const wrap = ['x', 'extherb'].includes(facts.formula) ? 'blister' : 'sachet';
  if ((wrap === 'blister' && facts.sachet) || (wrap === 'sachet' && facts.blister)) return null;
  if (facts.box) {
    const content = facts[wrap];
    if (!content || facts.box > 1) return null;
    return { key: JSON.stringify(['propoliz-lozenge', facts.formula, 8]),
      saleUnit: 'box', saleCount: facts.box, content };
  }
  if (!knownTitle && !facts[wrap]) return null;
  return { key: JSON.stringify(['propoliz-lozenge', facts.formula, 8]),
    saleUnit: wrap, saleCount: facts[wrap] || 1 };
}

function propolizProfile(name, variant, knownTitle, seed) {
  return /lozenge|เม็ดอม/u.test(name) ? lozengeProfile(name, variant, knownTitle, seed)
    : sprayProfile(name, variant, knownTitle);
}

function parseIherbPart(text) {
  const pack = packaging(text); if (!pack) return null;
  const volume = parseSize(pack.rest, 'ml'); if (!volume) return null;
  const counts = values(volume.rest, /(\d+)\s*(?:เม็ด|\btablets?\b|\blozenges?\b)/gu);
  if (counts.length && !one(counts)) return null;
  let rest = strip(volume.rest, /\d+\s*(?:เม็ด|\btablets?\b|\blozenges?\b)/gu);
  const otc = /\botc\b|โอทีซี/u.test(rest);
  const zip = /ซิป|\bzip\b/u.test(rest);
  const regular = /ซองปกติ|\bregular\b/u.test(rest);
  if (zip && regular) return null;
  rest = strip(rest, /ซองปกติ|ซิป|\bzip\b|\bregular\b|\botc\b|โอทีซี|ยาน้ำแก้ไอ|\bcough\s*syrup\b|เม็ดอมสมุนไพร|ยาอมสมุนไพร|เม็ดอม|ยาอม|สูตรปราศจากน้ำตาล|ปราศจากน้ำตาล|ชุ่มคอ|\bsugar\s*free\b|\bherbal\s*lozenges\b/gu);
  if (rest) return null;
  return { volume: volume.size, tabletCount: counts.length ? Number(one(counts)) : null,
    ...(otc ? { formula: 'otc' } : {}), ...(zip ? { wrap: 'zip' } : regular ? { wrap: 'regular' } : {}),
    ...(pack.quantities.bottle ? { bottle: pack.quantities.bottle } : {}),
    ...(pack.quantities.sachet ? { sachet: pack.quantities.sachet } : {}),
    ...(pack.quantities.box ? { box: pack.quantities.box } : {}) };
}
function iherbProfile(name, variant, knownTitle, seed) {
  let facts = knownTitle ? parseIherbPart(variant)
    : mergeFacts(parseIherbPart(removeBrand(name, 'iherb')), parseIherbPart(variant));
  if (!facts) return null;
  if (knownTitle) {
    const single = parseIherbPart(removeBrand(name, 'iherb'));
    if (single) facts = mergeFacts(single, facts);
  }
  if (!facts) return null;
  if (facts.volume) {
    if (facts.tabletCount || facts.box || facts.sachet || (!knownTitle && (!facts.bottle || facts.formula !== 'otc'))) return null;
    return { key: JSON.stringify(['iherb-syrup', 'otc', facts.volume]), saleCount: facts.bottle || 1, saleUnit: 'bottle' };
  }
  if (facts.tabletCount === 18 && facts.formula === 'otc' && !facts.wrap && !facts.box) {
    if (!knownTitle && !facts.sachet) return null;
    return { key: JSON.stringify(['iherb-lozenge', 'otc', 18]), saleCount: facts.sachet || 1, saleUnit: 'sachet' };
  }
  if (facts.tabletCount !== 8 || facts.formula || facts.box) return null;
  // Packaging is a discriminator. Only the exact confirmed listing frame may
  // inherit its zip fact; a new title saying merely 8 tablets is ambiguous.
  if (!facts.wrap && knownTitle && /ซิป|\bzip\b/iu.test(seed?.master?.name || seed?.evidence?.erpName || '')) facts.wrap = 'zip';
  if (!facts.wrap && knownTitle && seed?.catalogSourceRow) facts.wrap = 'regular';
  if (!facts.wrap || (!knownTitle && !facts.sachet)) return null;
  return { key: JSON.stringify(['iherb-lozenge', facts.wrap, 8]), saleCount: facts.sachet || 1, saleUnit: 'sachet' };
}

function parseSachetPart(text, family) {
  const pack = packaging(text); if (!pack || pack.quantities.bottle || pack.quantities.sheet) return null;
  const size = parseSize(pack.rest, family === 'onegerd' ? 'ml' : 'g'); if (!size) return null;
  let rest = size.rest;
  if (family === 'onegerd') {
    if (!/รสมินท์|มินท์|\bmint\b/u.test(rest) && rest) return null;
    rest = strip(rest, /รสมินท์|มินท์|\bmint\b|ปราศจากน้ำตาล|ไม่มีน้ำตาล|\bsugar\s*free\b|\bx\b/gu);
  } else {
    if (!/\bfiber\s*fiber\b|ไฟเบอร์\s*ไฟเบอร์/u.test(rest) && rest) return null;
    rest = strip(rest, /\bfiber\s*fiber\b|ไฟเบอร์\s*ไฟเบอร์|\bx\b/gu);
  }
  if (rest) return null;
  return { size: size.size, ...pack.quantities };
}
function sachetProfile(name, variant, knownTitle, family, seed) {
  let facts = knownTitle ? parseSachetPart(variant, family)
    : mergeFacts(parseSachetPart(removeBrand(name, family), family), parseSachetPart(variant, family));
  if (!facts) return null;
  if (knownTitle) {
    // Source pack facts are allowed only for the already-confirmed frame.
    const fromTitle = parseSachetPart(removeBrand(name, family), family);
    if (fromTitle) facts = mergeFacts(fromTitle, facts);
    if (!facts) return null;
    if (!facts.size && family === 'deeday') {
      const masterSize = parseSize(normalizeStructuralText(seed?.master?.name || seed?.evidence?.erpName), 'g');
      facts.size = masterSize?.size || null;
    }
  }
  if (family === 'deeday' && knownTitle && seed?.quantityPerSale > 1
    && seed?.master?.unit === 'ซอง' && !facts.box && !facts.sachet) {
    facts.box = 1; facts.sachet = seed.quantityPerSale;
  }
  if (!facts.size || (!facts.box && !facts.sachet)) return null;
  if (family === 'onegerd' && !knownTitle && !/รสมินท์|มินท์|\bmint\b/u.test(`${name} ${variant}`)) return null;
  const content = facts.box ? facts.sachet || null : null;
  // For a new title, box contents must be explicit. Box12 and box24 are two
  // different packages even if both use the same base sachet SKU.
  if (!knownTitle && facts.box && !content) return null;
  return { key: JSON.stringify([family, family === 'onegerd' ? 'mint' : 'fiber-fiber', facts.size]),
    saleUnit: facts.box ? 'box' : 'sachet', saleCount: facts.box || facts.sachet,
    content, size: facts.size };
}
function bactigrasProfile(name, variant, knownTitle) {
  const part = text => {
    text = strip(text, /แผ่นปิดแผล|\bdressing\b/gu);
    const pack = packaging(text); if (!pack || pack.quantities.bottle || pack.quantities.sachet) return null;
    const dims = values(pack.rest, /(\d+(?:\.\d+)?x\d+(?:\.\d+)?)\s*cm\b/gu);
    if (dims.length && !one(dims)) return null;
    const rest = strip(pack.rest, /\d+(?:\.\d+)?x\d+(?:\.\d+)?\s*cm\b|แผ่นปิดแผล|\bdressing\b|\//gu);
    return rest ? null : { dimensions: one(dims), ...pack.quantities };
  };
  const titleText = removeBrand(name, 'bactigras');
  const titleFacts = part(titleText); const variantFacts = part(variant);
  // The title describes contents of one retail box; the option may sell N
  // identical boxes. Contents and dimensions still have to agree.
  if (titleFacts && variantFacts?.box && (knownTitle || !/\d+\s*(?:กล่อง|\bbox(?:es)?\b|\bbx\b)/u.test(titleText))) delete titleFacts.box;
  const facts = mergeFacts(titleFacts, variantFacts);
  if (!facts?.dimensions || !facts.box || (!knownTitle && !facts.sheet)) return null;
  return { key: JSON.stringify(['bactigras', facts.dimensions]), saleUnit: 'box',
    saleCount: facts.box, content: facts.sheet || null };
}

// Packs of one verified ERP SKU can scale without a new hand-written mapping
// for each count. Formula/model and per-unit size remain part of the identity.
function retailCount(text, aliases) {
  const counts = values(text, new RegExp(`(\\d+)\\s*(?:${aliases.source})`, 'gu'));
  if (counts.length && !one(counts)) return null;
  const bare = new RegExp(aliases.source, 'gu').test(text);
  const count = counts.length ? Number(one(counts)) : bare ? 1 : null;
  if (count != null && (!Number.isSafeInteger(count) || count < 1 || count > MAX_FACTOR)) return null;
  return { count, rest: strip(text, new RegExp(`(?:\\d+\\s*)?(?:${aliases.source})`, 'gu')) };
}
function mydaProfile(name, variant, knownTitle, seed) {
  const part = text => {
    const size = parseSize(text, 'g'); if (!size) return null;
    const pack = retailCount(size.rest, /ก้อน|\bbars?\b/gu); if (!pack) return null;
    return { size: size.size, count: pack.count, rest: pack.rest };
  };
  const option = part(variant); if (!option) return null;
  let facts = option;
  if (!knownTitle) {
    const title = strip(name, /\bmyda\b|ไมด้า|\bsoap\b|สบู่|\bsulfur\b|ซัลเฟอร์|2\.5\s*%/gu);
    const header = part(title); if (!header || header.rest) return null;
    facts = mergeFacts(header, option);
    if (!facts || !/\bsulfur\b|ซัลเฟอร์/u.test(name) || !/2\.5\s*%/u.test(name)) return null;
  }
  if (facts.rest || !facts.size || (!knownTitle && !facts.count)) return null;
  if (knownTitle && !/2\.5\s*%/u.test(name) && !/2\.5\s*%/u.test(normalizeStructuralText(seed?.master?.name))) return null;
  return { key: JSON.stringify(['myda-soap', 'sulfur-2.5', facts.size]), saleUnit: 'bar',
    saleCount: facts.count || seed?.quantityPerSale || 1 };
}
function polarProfile(name, variant, knownTitle, seed) {
  const part = text => {
    const size = parseSize(text, 'ml'); if (!size) return null;
    const pack = retailCount(size.rest, /กระป๋อง|กป\.?|\bcans?\b/gu); if (!pack) return null;
    const formulae = [];
    if (/ฝาฟ้า|\bblue\b/u.test(pack.rest)) formulae.push('blue');
    if (/ฝาขาว|\bwhite\b|\binnocence\b|อินโนเซนส์|สูตรอ่อนโยน/u.test(pack.rest)) formulae.push('white');
    if (unique(formulae).length > 1) return null;
    const rest = strip(pack.rest, /ฝาฟ้า|ฝาขาว|\bblue\b|\bwhite\b|\binnocence\b|อินโนเซนส์|สูตรอ่อนโยน/gu);
    return { size: size.size, count: pack.count, formula: one(formulae), rest };
  };
  let facts = part(variant); if (!facts) return null;
  if (!knownTitle) {
    const header = part(strip(name, /\bpolar\b|โพลาร์|\bspray\b|สเปรย์/gu));
    if (!header || header.rest) return null;
    facts = mergeFacts(header, facts);
  }
  if (!facts || facts.rest || (!knownTitle && (!facts.count || !facts.formula || !facts.size))) return null;
  if (knownTitle) {
    const master = normalizeStructuralText(seed?.master?.name);
    if (!facts.size) facts.size = parseSize(master, 'ml')?.size;
    if (!facts.formula && /โพลาร์.*ยูคาลิปตัส/u.test(master)) facts.formula = /อินโนเซนส์|สูตรอ่อนโยน/u.test(master) ? 'white' : 'blue';
  }
  if (!facts.size || !facts.formula) return null;
  return { key: JSON.stringify(['polar-spray', facts.formula, facts.size]), saleUnit: 'can',
    saleCount: facts.count || seed?.quantityPerSale || 1 };
}
function yokiProfile(name, variant, knownTitle, seed) {
  const part = text => {
    const size = parseSize(text, 'g'); if (!size) return null;
    const pack = retailCount(size.rest, /ขวด|กระป๋อง|\bbottles?\b|\bcans?\b/gu); if (!pack) return null;
    const models = [];
    if (/1997/u.test(pack.rest)) models.push('1997');
    if (/รัศมีวงกลม|รัสมีวงกลม|\bcircle\b/u.test(pack.rest)) models.push('circle');
    if (unique(models).length > 1) return null;
    return { size: size.size, count: pack.count, model: one(models),
      rest: strip(pack.rest, /\byoki\b|โยคี|1997|ในรัศมีวงกลม|รัศมีวงกลม|ในรัสมีวงกลม|รัสมีวงกลม|\bcircle\b/gu) };
  };
  let facts = part(variant); if (!facts) return null;
  if (!knownTitle) {
    const header = part(strip(name, /\bpowder\b|แป้ง/gu)); if (!header || header.rest) return null;
    facts = mergeFacts(header, facts);
  }
  if (!facts || facts.rest || !facts.size || (!knownTitle && (!facts.count || !facts.model))) return null;
  if (knownTitle && !facts.model) {
    const master = normalizeStructuralText(seed?.master?.name);
    if (/รัศมีวงกลม|รัสมีวงกลม/u.test(master)) facts.model = 'circle';
    else if (/1997/u.test(normalizeStructuralText(seed?.variant))) facts.model = '1997';
  }
  if (!facts.model) return null;
  return { key: JSON.stringify(['yoki-powder', facts.model, facts.size]), saleUnit: 'retail-unit',
    saleCount: facts.count || seed?.quantityPerSale || 1 };
}

function profileFor(seedOrItem, knownTitle, seed) {
  const name = normalizeStructuralText(seedOrItem.productName || seedOrItem.name);
  const variant = normalizeStructuralText(seedOrItem.variant);
  if (hasBundle(`${name} ${variant}`)) return null;
  const family = familyFor(name);
  const parsers = { sos: sosProfile, propoliz: propolizProfile, iherb: iherbProfile,
    bactigras: bactigrasProfile, myda: mydaProfile, polar: polarProfile, yoki: yokiProfile };
  const profile = parsers[family] ? parsers[family](name, variant, knownTitle, seed)
    : ['onegerd', 'deeday'].includes(family) ? sachetProfile(name, variant, knownTitle, family, seed) : null;
  return profile ? { ...profile, family } : null;
}

function buildVerifiedCopyIndex(data = rules, listingCatalog = catalog) {
  const masters = new Map(data.masters.map(m => [m.companySku, m]));
  const seeds = data.rules.filter(r => r.companySku && !r.components && r.authority
    && !r.authority.includes('accounting_consolidation')
    && masters.has(r.companySku) && Number.isSafeInteger(r.quantityPerSale) && r.quantityPerSale > 0);
  // Only base-unit/quantity evidence permits a catalog record to seed a pack.
  // A catalog SKU alone does not prove a retail box contains N base units.
  const quantityRules = buildAutomaticQuantityRules(listingCatalog.records);
  for (const record of listingCatalog.records) {
    if (record.match.status !== 'matched' || !masters.has(record.match.companySku)) continue;
    const master = masters.get(record.match.companySku);
    const quantityRule = quantityRules.get(record);
    const packagingFacts = extractPackagingQuantities(record.variant);
    const explicitBase = [...packagingFacts.entries()].filter(([unit, counts]) => UNIT_LABELS[unit] === master.unit && counts.size === 1);
    const factor = quantityRule?.quantityRuleStatus === 'verified' && UNIT_LABELS[quantityRule.quantityUnit] === master.unit
      ? quantityRule.quantityPerSale : !quantityRule && explicitBase.length === 1 ? [...explicitBase[0][1]][0] : null;
    if (!factor || data.unitReviews.some(r => r.companySku === record.match.companySku && r.variant === record.variant)) continue;
    seeds.push({ shopCode: record.shopCode, productName: record.productName, variant: record.variant,
      companySku: record.match.companySku, quantityPerSale: factor, authority: 'existing_verified_catalog',
      catalogSourceRow: record.sourceRow });
  }
  const formatted = new Map(); const titles = new Map(); const profiles = new Map();
  const append = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
  for (const seed of seeds) {
    append(formatted, identityKey(seed.shopCode, seed.productName, seed.variant), seed);
    append(titles, JSON.stringify([seed.shopCode, formattingKey(seed.productName)]), seed);
    const profile = profileFor(seed, true, { ...seed, master: masters.get(seed.companySku) });
    if (profile) append(profiles, JSON.stringify([seed.shopCode, profile.key]), { seed, profile });
  }
  const blocked = new Set(data.rules.filter(r => r.components || r.authority?.includes('accounting_consolidation'))
    .map(r => identityKey(r.shopCode, r.productName, r.variant)));
  return { masters, seeds, formatted, titles, profiles, blocked, listingCatalog };
}
const index = buildVerifiedCopyIndex();
function signature(rule, factor = rule.quantityPerSale) { return JSON.stringify([rule.companySku, factor]); }
function review(reasonCode, candidates = []) {
  return { status: 'review', reasonCode, candidates: unique(candidates.map(c => c.companySku)).sort().slice(0, 10) };
}
function result(seed, factor, method, profile) {
  return { status: 'matched', rule: { ...seed, quantityPerSale: factor },
    provenance: { version: VERIFIED_COPY_MATCH_VERSION, method,
      anchor: { shopCode: seed.shopCode, productName: seed.productName, variant: seed.variant,
        companySku: seed.companySku, quantityPerSale: seed.quantityPerSale, authority: seed.authority,
        ...(seed.evidence ? { evidence: seed.evidence } : {}),
        ...(seed.catalogSourceRow ? { catalogSourceRow: seed.catalogSourceRow } : {}) },
      ...(profile ? { structuralKey: profile.key } : {}) } };
}
function resolveVerifiedCopyMatch(shopCode, item, matchIndex = index) {
  const key = identityKey(shopCode, item.name, item.variant);
  if (matchIndex.blocked.has(key) || hasBundle(normalizeStructuralText(`${item.name} ${item.variant || ''}`))) {
    return review('automatic_bundle_or_special_authority_hold');
  }
  const formatted = matchIndex.formatted.get(key) || [];
  if (formatted.length) {
    if (unique(formatted.map(r => signature(r))).length !== 1) return review('automatic_evidence_conflict', formatted);
    return result(formatted[0], formatted[0].quantityPerSale, 'verified_formatting_identity');
  }
  const titleSeeds = matchIndex.titles.get(JSON.stringify([shopCode, formattingKey(item.name)])) || [];
  let attempts;
  if (titleSeeds.length) {
    // Parse in each evidenced frame so zip packaging facts cannot come from an
    // unrelated title. A title selected from two incompatible frames fails.
    const context = seed => ({ ...seed, master: matchIndex.masters.get(seed.companySku) });
    const allowedProfiles = new Set(titleSeeds.map(seed => profileFor(seed, true, context(seed))?.key).filter(Boolean));
    attempts = titleSeeds.map(seed => profileFor(item, true, context(seed))).filter(p => p && allowedProfiles.has(p.key));
  } else attempts = [profileFor(item, false)].filter(Boolean);
  if (!attempts.length) {
    const family = familyFor(normalizeStructuralText(item.name));
    const candidates = matchIndex.seeds.filter(s => s.shopCode === shopCode && family && familyFor(normalizeStructuralText(s.productName)) === family);
    return review(family ? 'automatic_attributes_or_pack_incomplete' : 'automatic_family_not_supported', candidates);
  }
  const resolutions = [];
  for (const profile of attempts) {
    for (const candidate of matchIndex.profiles.get(JSON.stringify([shopCode, profile.key])) || []) {
      const { seed, profile: anchor } = candidate;
      if (profile.saleUnit !== anchor.saleUnit) continue;
      if (profile.content != null && profile.content !== anchor.content) continue;
      if (profile.sheetCount != null) {
        const master = matchIndex.masters.get(seed.companySku);
        const counts = values(normalizeStructuralText(master.name), /(\d+)\s*(?:ชิ้น|แผ่น)/gu);
        if (!counts.length || Number(one(counts)) !== profile.sheetCount) continue;
      }
      const currentCount = profile.boxCount || profile.saleCount;
      const anchorCount = anchor.boxCount || anchor.saleCount;
      const factor = seed.quantityPerSale * currentCount / anchorCount;
      if (!Number.isSafeInteger(factor) || factor < 1 || factor > MAX_FACTOR) continue;
      resolutions.push({ seed, factor, profile });
    }
  }
  if (!resolutions.length) return review('automatic_attributes_or_pack_not_verified');
  if (unique(resolutions.map(r => signature(r.seed, r.factor))).length !== 1) {
    return review('automatic_evidence_conflict', resolutions.map(r => r.seed));
  }
  const selected = resolutions[0];
  return result(selected.seed, selected.factor, 'verified_structural_attributes', selected.profile);
}

// Imported items currently contain no IDs/barcodes. If a direct caller supplies
// them, contradictory or unknown metadata must not be ignored. These checks do
// not create an ID-only or barcode-only matching path.
function sourceIdentifierConflict(shopCode, item, resolvedRule, matchIndex = index) {
  const identifiers = [['productId', 'listingProductId'], ['variationId', 'listingVariationId'], ['barcode', 'sourceBarcode']]
    .map(keys => unique(keys.map(k => item[k]).filter(v => v != null && String(v).trim()).map(String)));
  if (identifiers.some(v => v.length > 1)) return 'source_identifier_conflict';
  const [products, variants, barcodes] = identifiers;
  if (products.length || variants.length) {
    if (products.length !== 1 || variants.length !== 1) return 'source_identifiers_incomplete';
    const records = matchIndex.listingCatalog.records.filter(r => r.shopCode === shopCode
      && String(r.productId) === products[0] && String(r.variationId) === variants[0]);
    if (records.length !== 1 || records[0].match.status !== 'matched'
      || records[0].match.companySku !== resolvedRule.companySku) return 'source_identifier_conflict';
    const record = records[0];
    const packAnchors = matchIndex.formatted.get(identityKey(shopCode, record.productName, record.variant)) || [];
    if (!packAnchors.length || unique(packAnchors.map(r => signature(r))).length !== 1
      || packAnchors[0].quantityPerSale !== (resolvedRule.quantityPerSale || 1)) return 'source_identifier_pack_not_verified';
  }
  if (barcodes.length) {
    const allowed = [resolvedRule.sourcePackBarcode,
      ...(resolvedRule.quantityPerSale === 1 ? [resolvedRule.erpBaseUnitBarcode, resolvedRule.evidence?.erpBarcode] : [])].filter(Boolean);
    if (!allowed.includes(barcodes[0])) return 'source_barcode_not_verified_for_pack';
  }
  return null;
}
function getVerifiedCopyMatcherDigest() {
  return crypto.createHash('sha256').update(JSON.stringify({ version: VERIFIED_COPY_MATCH_VERSION,
    masters: rules.masters, rules: rules.rules, unitReviews: rules.unitReviews })).digest('hex');
}
module.exports = { VERIFIED_COPY_MATCH_VERSION, buildVerifiedCopyIndex, formattingKey,
  getVerifiedCopyMatcherDigest, normalizeStructuralText, resolveVerifiedCopyMatch, sourceIdentifierConflict };
