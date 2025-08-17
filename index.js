require('dotenv').config();
const express = require('express');
const cors = require('cors');
const PKG = require('../package.json');
const PDFDocument = require('pdfkit');

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3003;
const API_KEY = process.env.GOOGLE_CSE_KEY;
const CX = process.env.GOOGLE_CSE_CX;
const USD_TO_SAR = Number(process.env.USD_TO_SAR || 3.75);

/* ---------- Helpers ---------- */
const GCC_TLDS = new Set(['sa','bh','qa','ae','kw','om']);
const MONTH = {
jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11
};

function domainFromUrl(u){
try{
const h = new URL(u).hostname.toLowerCase();
const p = h.replace(/^www\./,'').split('.');
if (p.length>=2) return {root: p.slice(-2).join('.'), tld: p.at(-1), host: h};
return {root:h, tld:'', host:h};
}catch{ return {root:'', tld:'', host:''}; }
}

function titleCase(s){
return s.replace(/\s+/g,' ').trim()
.replace(/\b([a-z])/g, m => m.toUpperCase());
}

function extractPriceUSD(text){
// $850 or 850 USD (avoid huge numbers)
const m = text.match(/\$ ?([0-9]{2,5})\b|(?:^|\s)([0-9]{2,5}) ?USD\b/i);
if(!m) return null;
const v = Number(m[1] || m[2]);
if(Number.isNaN(v)) return null;
return v;
}

function extractAccredited(text){
return /accredit(ed|ation)/i.test(text);
}

function extractReputation(text){
const m = text.match(/\b([0-5](?:\.[0-9])?)\/5\b/);
return m ? Number(m[1]) : null;
}

function extractStatus(text){
if (/full(?!y)/i.test(text)) return 'Full';
if (/open/i.test(text)) return 'Open';
return null;
}
function extractSeatsLimited(text){
return /limited seats/i.test(text);
}

function parseDateToken(tok){
// supports YYYY-MM-DD or DD Mon YYYY / Mon DD, YYYY
tok = tok.replace(/[,]/g,'').trim();
// 2025-09-12
if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return new Date(tok);
// 12 Sep 2025
let m = tok.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
if (m){
const d=Number(m[1]), mon=MONTH[m[2].slice(0,3).toLowerCase()], y=Number(m[3]);
if(mon!=null) return new Date(y,mon,d);
}
// Sep 12 2025
m = tok.match(/^([A-Za-z]{3,})\s+(\d{1,2})\s+(\d{4})$/);
if (m){
const mon=MONTH[m[1].slice(0,3).toLowerCase()], d=Number(m[2]), y=Number(m[3]);
if(mon!=null) return new Date(y,mon,d);
}
return null;
}
function extractDates(text){
// look for two date tokens around "to/–/→"
const tokens = [];
const rx = /\b(\d{4}-\d{2}-\d{2}|[0-3]?\d\s+[A-Za-z]{3,}\s+\d{4}|[A-Za-z]{3,}\s+[0-3]?\d\s+\d{4})\b/g;
let m; while((m = rx.exec(text)) && tokens.length < 2) tokens.push(m[1]);
if (tokens.length >= 2){
const a = parseDateToken(tokens[0]);
const b = parseDateToken(tokens[1]);
if (a && b) return { start: a.toISOString().slice(0,10), end: b.toISOString().slice(0,10) };
}
return {start:null, end:null};
}

function guessVendor(title, snippet, link){
// 1) “… — Vendor: X”
const mVendor = (title + ' — ' + snippet).match(/Vendor:\s*([^\n\-|]{2,80})/i);
if (mVendor) return mVendor[1].trim();
// 2) “by XYZ”
const mBy = (title + ' ' + snippet).match(/\bby\s+([A-Za-z0-9 &’'._-]{2,80})/i);
if (mBy) return mBy[1].trim();
// 3) from domain
const d = domainFromUrl(link).root.split('.')[0]
.replace(/[-_]/g,' ')
.replace(/\b\w/g, c=>c.toUpperCase());
return d;
}

function extractLocation(text){
// very light heuristics: look for City, Country pattern
const m = text.match(/\b([A-Z][a-zA-Z]+)(?:,\s*([A-Z][a-zA-Z ]+))\b/);
if (m) return { city:m[1], country:m[2] || null };
// single country word
const m2 = text.match(/\b(Saudi Arabia|Bahrain|Qatar|United Arab Emirates|Kuwait|Oman)\b/i);
if (m2) return { city:null, country: titleCase(m2[1]) };
return { city:null, country:null };
}

function locationRank({city, country}, link, query){
const d = domainFromUrl(link);
const host = d.host;
const inKSA = /(\.sa\b|saudi|riyadh|jeddah|yanbu)/i.test(host + ' ' + (city||'') + ' ' + (country||''));
const isGCC = GCC_TLDS.has(d.tld);
// rank: 0 Yanbu, 1 KSA, 2 GCC, 3 global
if (/yanbu/i.test(query) || /yanbu/i.test((city||'') + ' ' + (country||''))) return 0;
if (inKSA) return 1;
if (isGCC) return 2;
return 3;
}

/* ---------- /ask ---------- */
app.post('/ask', async (req, res) => {
try{
const q = String(req.body.message || '').trim();
if (!q) return res.status(400).json({ ok:false, reply:'Please type a course name.'});

// نُضيف كلمات تضييق للمحتوى التعليمي فقط
const query = `${q} (course OR training OR workshop OR certificate) (register OR schedule OR dates OR start)`;

const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(query)}&num=10`;
const r = await fetch(url);
if (!r.ok) throw new Error(`CSE error: ${r.status}`);
const data = await r.json();

const items = (data.items || []).map((it, i) => {
const t = it.title || '';
const sn = it.snippet || '';
const link = it.link || '';
const combined = `${t} — ${sn}`;

const priceUSD = extractPriceUSD(combined);
const { start, end } = extractDates(combined);
const accredited = extractAccredited(combined);
const reputation = extractReputation(combined);
const status = extractStatus(combined);
const seatsLimited = extractSeatsLimited(combined);
const vendor = guessVendor(t, sn, link);
const loc = extractLocation(combined);
const rank = locationRank(loc, link, q);

return {
id: String(i+1),
title: t,
link,
snippet: sn,
priceUSD,
priceSAR: priceUSD ? Math.round(priceUSD * USD_TO_SAR) : null,
accredited,
reputation,
status,
seatsLimited,
vendor,
city: loc.city,
country: loc.country,
start, end,
locRank: rank
};
});

// فلترة: حاول إبقاء النتائج التي تبدو “كورسات”
const onlyCourses = items.filter(it =>
/(course|training|workshop|program|instructor)/i.test(it.title + ' ' + it.snippet)
);

// ترتيب: الموقع (Yanbu → KSA → GCC → عالمي) ثم السعر صعودي
const sorted = onlyCourses.sort((a,b)=>{
if (a.locRank !== b.locRank) return a.locRank - b.locRank;
const pa = a.priceUSD ?? Infinity, pb = b.priceUSD ?? Infinity;
if (pa !== pb) return pa - pb;
return (a.title||'').localeCompare(b.title||'');
});

res.json({ ok:true, reply:`Found ${sorted.length} result(s)`, results: sorted });
}catch(e){
console.error(e);
res.status(500).json({ ok:false, reply:'Server error. Please try again.'});
}
});

/* ---------- Reports: CSV ---------- */
app.post('/report/csv', (req, res) => {
try{
const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
let csv = 'Course Name,Vendor,City,Country,Start,End,Price USD,Price SAR (approx),Accredited,Reputation,Availability,URL,Contact\n';
for (const r of rows){
const line = [
r.title||'',
r.vendor||'',
r.city||'',
r.country||'',
r.start||'',
r.end||'',
r.priceUSD??'',
r.priceSAR??'',
r.accredited ? 'Yes':'No',
r.reputation??'',
r.status||'',
r.link||'',
r.contact||''
].map(v => String(v).replace(/"/g,'""'));
csv += `"${line.join('","')}"\n`;
}
res.setHeader('Content-Type', 'text/csv; charset=utf-8');
res.setHeader('Content-Disposition', 'attachment; filename="courses_report.csv"');
return res.send(csv);
}catch(e){
console.error(e);
res.status(500).end('CSV error');
}
});

/* ---------- Reports: PDF (بسيط وواضح) ---------- */
app.post('/report/pdf', (req, res) => {
try{
const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
res.setHeader('Content-Type', 'application/pdf');
res.setHeader('Content-Disposition', 'attachment; filename="courses_report.pdf"');

const doc = new PDFDocument({ margin: 42, size: 'A4' });
doc.pipe(res);

doc.fontSize(18).text('Courses Report', { align:'left' });
doc.moveDown(0.6);

const headers = ['Course Name','Vendor','City','Country','Start','End','Price USD','Price SAR','Accredited','Reputation','Availability','Contact','URL'];
const colW = [120,90,60,70,62,62,60,60,65,65,70,90,150];
const x0 = doc.x, y0 = doc.y;

// Header row
doc.fontSize(9).fillColor('#000').font('Helvetica-Bold');
headers.forEach((h, i)=>{
doc.text(h, x0 + colW.slice(0,i).reduce((a,c)=>a+c,0), y0, { width: colW[i] });
});
doc.moveDown(0.5);
doc.font('Helvetica').fontSize(9);
let y = doc.y;

rows.forEach(r=>{
const vals = [
r.title||'', r.vendor||'', r.city||'', r.country||'',
r.start||'', r.end||'',
r.priceUSD??'', r.priceSAR??'',
r.accredited?'Yes':'No', r.reputation??'',
r.status||'', r.contact||'', r.link||''
];
let rowHeight = 0;
// measure tallest cell
vals.forEach((v,i)=>{
const h = doc.heightOfString(String(v), { width: colW[i] });
rowHeight = Math.max(rowHeight, h);
});
// new page if needed
if (y + rowHeight > doc.page.height - 60){
doc.addPage();
y = 42;
}
// draw cells
vals.forEach((v,i)=>{
doc.text(String(v), x0 + colW.slice(0,i).reduce((a,c)=>a+c,0), y, { width: colW[i] });
});
y += rowHeight + 6;
doc.moveTo(x0, y).lineTo(x0 + colW.reduce((a,c)=>a+c,0), y).strokeColor('#e5e7eb').stroke();
y += 4;
});

doc.end();
}catch(e){
console.error(e);
res.status(500).end('PDF error');
}
});

app.listen(PORT, () => {
console.log(`Server is running on port ${PORT} 🚀 — ${PKG.name} ${PKG.version}`);
});