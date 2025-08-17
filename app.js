async function sendMessage(){
const input = document.getElementById('message');
const status = document.getElementById('status');
const resultsEl = document.getElementById('results');
resultsEl.innerHTML = '';
status.textContent = 'Searching… ⏳';

try{
const res = await fetch('/ask', {
method:'POST',
headers:{ 'Content-Type':'application/json' },
body: JSON.stringify({ message: input.value })
});
if(!res.ok) throw new Error('bad status ' + res.status);
const data = await res.json();

if (!data.ok || !data.results || data.results.length === 0){
status.textContent = 'No results found.';
return;
}
status.textContent = `Found ${data.results.length} result(s).`;
renderList(data.results);
}catch(err){
console.error(err);
status.textContent = 'Server error. Please try again.';
}
}

function renderList(list){
const wrap = document.getElementById('results');
wrap.innerHTML = '';
list.forEach((r, idx) => {
wrap.appendChild(renderCourseCard(r, idx));
});
wireReportButtons();
}

function renderCourseCard(r, i){
const card = document.createElement('div');
card.className = 'card';
card.dataset.id = r.id;

const priceTop = (r.city || r.country || r.priceUSD)
? `<div class="pills">
<span class="pill pill--place">
${r.city ? r.city : (r.country || '•')}
${r.priceUSD ? ` • $${r.priceUSD} <small>(≈ ${r.priceSAR} SAR)</small>` : ''}
</span>
</div>` : '';

const badges = [];
if (r.accredited) badges.push(`<span class="badge badge--blue">Accredited</span>`);
if (r.reputation) badges.push(`<span class="badge badge--rep">Reputation: ${r.reputation}/5</span>`);
if (r.status === 'Open') badges.push(`<span class="badge badge--ok">Open</span>`);
if (r.status === 'Full') badges.push(`<span class="badge badge--full">Full</span>`);
if (r.seatsLimited) badges.push(`<span class="badge badge--warn">Limited seats</span>`);

const vContact = contactGuess(r.link);

card.innerHTML = `
<div class="card-title">${r.title || 'Course'}</div>
${priceTop}
<div class="badges">${badges.join('')}</div>
<div class="meta">
Vendor: <strong>${r.vendor || '—'}</strong>
<span class="sep">—</span>
<span>Date: ${r.start || '—'} → ${r.end || '—'}</span>
<span class="sep">—</span>
<a href="${r.link}" target="_blank" rel="noopener">Details</a>
</div>
<label class="add"><input type="checkbox" class="pick">Add to report</label>
`;

// stash row snapshot for report creation
card._row = {
id: r.id,
title: r.title,
vendor: r.vendor,
city: r.city,
country: r.country,
start: r.start,
end: r.end,
priceUSD: r.priceUSD,
priceSAR: r.priceSAR,
accredited: r.accredited,
reputation: r.reputation,
status: r.status,
link: r.link,
contact: vContact
};
return card;
}

function contactGuess(link){
const d = new URL(link).origin;
return `${d}/contact, ${d}/contact-us`;
}

function wireReportButtons(){
const picks = Array.from(document.querySelectorAll('.pick'));

document.getElementById('btn-contacts').onclick = () => {
const contactsBox = document.getElementById('contacts');
const ul = document.getElementById('contacts-list');
ul.innerHTML = '';
// generate from all cards (distinct vendors)
const map = new Map();
document.querySelectorAll('.card').forEach(c=>{
const row = c._row;
if (!row) return;
if (!map.has(row.vendor)) map.set(row.vendor, row.contact);
});
for (const [vendor, contact] of map){
const li = document.createElement('li');
li.textContent = `${vendor} — ${contact}`;
ul.appendChild(li);
}
contactsBox.style.display = 'block';
};

document.getElementById('btn-csv').onclick = async () => {
const rows = picks.filter(p=>p.checked).map(p => p.closest('.card')._row);
if (rows.length === 0){ alert('Select at least one course.'); return; }
const res = await fetch('/report/csv', {
method:'POST',
headers:{'Content-Type':'application/json'},
body: JSON.stringify({ rows })
});
const blob = await res.blob();
downloadBlob(blob, 'courses_report.csv');
};

document.getElementById('btn-pdf').onclick = async () => {
const rows = picks.filter(p=>p.checked).map(p => p.closest('.card')._row);
if (rows.length === 0){ alert('Select at least one course.'); return; }
const res = await fetch('/report/pdf', {
method:'POST',
headers:{'Content-Type':'application/json'},
body: JSON.stringify({ rows })
});
const blob = await res.blob();
downloadBlob(blob, 'courses_report.pdf');
};
}

function downloadBlob(blob, filename){
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url; a.download = filename; a.click();
setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

/* wire UI */
document.getElementById('send').addEventListener('click', sendMessage);
document.getElementById('message').addEventListener('keydown', e=>{
if (e.key === 'Enter') sendMessage();
});
