
(function(){
  'use strict';

  // ── Closing checklist definitions ─────────────────────────────────────────
  // temp:{max}|{min} → logs a close-down temperature, auto-judges vs target.
  //   in-range = auto-complete · out-range = blocker
  // blocker:true = hard gate on closing the day.
  const SECTIONS = [
    { key:'safety', title:'Food safety & close-down', icon:'<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"/>' },
    { key:'clean',  title:'Clean-down',               icon:'<path d="M3 21l4-4M14 4l6 6M12 6l6 6-5 5-7-1-1-7 5-3z"/>' },
    { key:'cash',   title:'Cash & POS close',         icon:'<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M2 10h20M6 14h4"/>' },
    { key:'prep',   title:'Prep & storage for tomorrow', icon:'<path d="M20 7L12 3 4 7l8 4 8-4z"/><path d="M4 7v10l8 4 8-4V7"/>' },
  ];

  const DATA = {
    safety: [
      { id:'eod:walkin-a', title:'Walk-in A — close temp logged', meta:'TARGET ≤ 4°C · after service', temp:{ max:4 }, seed:3.4 },
      { id:'eod:walkin-b', title:'Walk-in B — close temp logged', meta:'TARGET ≤ 4°C', temp:{ max:4 }, seed:3.1 },
      { id:'eod:freezer',  title:'Freezer — close temp logged',   meta:'TARGET ≤ −18°C', temp:{ max:-18 }, seed:-19.5 },
      { id:'eod:cooldown', title:'Hot food blast-chilled & date-labelled', meta:'shakshuka · stocks · sauces · 90 min rule' },
      { id:'eod:safety-log', title:'Food-safety log signed off', meta:'cleaning + temps · daily record', blocker:true },
    ],
    clean: [
      { id:'eod:surfaces', title:'Line & prep surfaces sanitised', meta:'all stations · dated buckets emptied' },
      { id:'eod:grill',    title:'Grill, fryer & flat-top cleaned', meta:'oil filtered · Marco', right:{ value:'done', sub:'oil ok', tint:'ok' } },
      { id:'eod:floors',   title:'Floors mopped · bins & recycling out', meta:'kitchen + FOH' },
      { id:'eod:dish',     title:'Dishwasher run, emptied & drained', meta:'racks stacked for AM' },
      { id:'eod:gas',      title:'Extraction, gas & equipment off', metaAlert:'safety-critical before lock-up', blocker:true },
    ],
    cash: [
      { id:'eod:zreport',  title:'Z-report run & filed', meta:'POS end-of-day', right:{ value:'run', sub:'23:02', tint:'ok' } },
      { id:'eod:drawer',   title:'Cash drawer counted & reconciled', meta:'float $300 held back', right:{ value:'−$4.20', sub:'over float', tint:'warn' } },
      { id:'eod:tips',     title:'Tips pooled & recorded', meta:'$412 · split 9 staff' },
      { id:'eod:safe',     title:'Safe drop logged & sealed', meta:'banking bag · Thu pickup' },
      { id:'eod:sync',     title:'Sales synced to Controla', meta:'feeds cost + variance', right:{ value:'synced', sub:'auto', tint:'ok' } },
    ],
    prep: [
      { id:'eod:thaw',     title:'Proteins pulled to thaw for AM', meta:'per tomorrow forecast · lamb + chicken' },
      { id:'eod:fifo',     title:'Mise rotated FIFO · everything dated', meta:'walk-ins + dry store' },
      { id:'eod:86',       title:'86 board updated for tomorrow', meta:'soft-shell crab off · oysters back' },
      { id:'eod:delivery', title:'Delivery & dry store secured', meta:'AM drop area clear for Gembrook' },
      { id:'eod:lockup',   title:'Alarm set & premises locked', metaAlert:'last one out', blocker:true },
    ],
  };

  // ── Prep-for-tomorrow suggestions ──────────────────────────────────────────
  const PREP = [
    { id:'prep:shakshuka', name:'Shakshuka base', qty:'10 kg', unit:'re-batch', why:'0 kg left after service · 24 covers forecast', prio:'high' },
    { id:'prep:toast',     name:'French toast batter', qty:'6 L', unit:'brunch', why:'88 covers forecast Sat brunch', prio:'med' },
    { id:'prep:pesto',     name:'Pesto', qty:'2 kg', unit:'top-up', why:'~30 plates left · basil delivery AM', prio:'med' },
    { id:'prep:curd',      name:'Lemon curd', qty:'1 batch', unit:'fresh AM', why:'lemon tart sold 39 · make fresh', prio:'med' },
    { id:'prep:shallots',  name:'Pickled shallots', qty:'2 L', unit:'top-up', why:'ran low on the pass tonight', prio:'high' },
  ];

  // ── Order suggestions (below par) ──────────────────────────────────────────
  const ORDERS = [
    { id:'ord:lamb',   sup:'Ordino Wholesale Meats', dot:'var(--c-proteins)', name:'Lamb rump',  onhand:3, par:15, qty:12, step:1, unit:'kg', price:28 },
    { id:'ord:chick',  sup:'Ordino Wholesale Meats', dot:'var(--c-proteins)', name:'Chicken thigh', onhand:2, par:10, qty:8, step:1, unit:'kg', price:9 },
    { id:'ord:leaves', sup:'Gembrook Produce', dot:'var(--c-garnish)', name:'Mixed leaves', onhand:1, par:6, qty:5, step:1, unit:'crate', price:18 },
    { id:'ord:toms',   sup:'Gembrook Produce', dot:'var(--c-garnish)', name:'Vine tomatoes', onhand:2, par:10, qty:8, step:1, unit:'kg', price:6 },
    { id:'ord:lemons', sup:'Gembrook Produce', dot:'var(--c-garnish)', name:'Lemons', onhand:0.5, par:2, qty:2, step:1, unit:'box', price:22 },
    { id:'ord:oil',    sup:'Pantry & Dry Co.', dot:'var(--c-base)', name:'Extra-virgin olive oil', onhand:1, par:5, qty:4, step:1, unit:'×5L', price:62, flag:'+18% today' },
  ];

  // ── Persistent per-day state ───────────────────────────────────────────────
  const ymd = (d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const KEY = `eod:${ymd(new Date())}`;
  let done = {};      // { id:bool } task ticks
  let temps = {};     // { id:number|null } close-down temps
  let prep = {};      // { id:bool } queued to tomorrow's prep board
  let order = {};     // { id:{on:bool, qty:number} }
  let handover = '';

  (function hydrate(){
    let raw=null; try{ raw = localStorage.getItem(KEY); }catch(e){}
    if(raw){
      try{ const p=JSON.parse(raw); done=p.done||{}; temps=p.temps||{}; prep=p.prep||{}; order=p.order||{}; handover=p.handover||''; }
      catch(e){}
    } else {
      DATA.safety.forEach(it=>{ if(it.temp && it.seed!=null) temps[it.id]=it.seed; });
    }
    // seed order defaults
    ORDERS.forEach(o=>{ if(!order[o.id]) order[o.id] = { on:true, qty:o.qty }; });
  })();
  function persist(){ try{ localStorage.setItem(KEY, JSON.stringify({done,temps,prep,order,handover})); }catch(e){} }

  const fmt = (n)=> n%1===0 ? n.toFixed(0) : n.toFixed(1);
  const money = (n)=> '$'+Math.round(n).toLocaleString();
  const $ = (id)=>document.getElementById(id);

  function allItems(){ return SECTIONS.flatMap(s=>DATA[s.key]); }
  function judge(item){
    const v = temps[item.id], t = item.temp;
    if(v==null || Number.isNaN(v)) return { tint:'neutral', value:'—', sub:'log it', over:false };
    const over = (t.max!==undefined && v>t.max) || (t.min!==undefined && v<t.min);
    return { tint: over?'bad':'ok', value: fmt(v)+'°C', sub: over?'out of range':'good', over };
  }
  function isDone(item){
    if(done[item.id]) return true;
    if(item.temp && judge(item).tint==='ok') return true;
    return false;
  }
  function isBlocking(item){
    if(isDone(item)) return false;
    if(item.blocker) return true;
    if(item.temp && judge(item).over) return true;
    return false;
  }

  // ── Build closing checklist DOM ────────────────────────────────────────────
  const sectionsRoot = $('sections');
  const refs = new Map();
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';

  function buildSections(){
    refs.clear(); sectionsRoot.innerHTML='';
    SECTIONS.forEach(sec=>{
      const wrap=document.createElement('div'); wrap.className='sec';
      wrap.innerHTML = `
        <div class="sec-head">
          <h3><span class="ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${sec.icon}</svg></span> ${sec.title}</h3>
          <span class="prog" data-sec="${sec.key}">0 / ${DATA[sec.key].length}</span>
        </div>`;
      DATA[sec.key].forEach(it=> wrap.appendChild(buildRow(it)));
      sectionsRoot.appendChild(wrap);
    });
  }

  function buildRow(item){
    const row=document.createElement('div');
    row.className='chk'+(item.temp?' is-temp':'');
    const metaHtml=(item.meta||'')+(item.meta&&item.metaAlert?' <span class="sep">·</span> ':'')+(item.metaAlert?`<b style="color:var(--red-text)">${item.metaAlert}</b>`:'');
    row.innerHTML = `
      <div class="box">${CHECK}</div>
      <div class="c-body">
        <div class="t"><span class="tt">${item.title}</span></div>
        ${(item.meta||item.metaAlert)?`<div class="m">${metaHtml}</div>`:''}
      </div>`;
    const box=row.querySelector('.box');
    let input=null, judgeEl=null, tgt=null, sub=null, rcell=null, plain=false;

    if(item.temp){
      rcell=document.createElement('div'); rcell.className='temp-cell';
      rcell.innerHTML = `
        <input class="temp-in" type="number" inputmode="decimal" step="0.1" placeholder="—" aria-label="Log temperature for ${item.title}" />
        <div class="temp-judge"><span class="tgt"></span><span class="sub"></span></div>`;
      input=rcell.querySelector('.temp-in'); judgeEl=rcell.querySelector('.temp-judge');
      tgt=rcell.querySelector('.tgt'); sub=rcell.querySelector('.sub');
      const v=temps[item.id]; input.value=(v==null||Number.isNaN(v))?'':v;
      input.addEventListener('input', ()=>{
        const raw=input.value.trim();
        temps[item.id]= raw==='' ? null : (Number.isNaN(Number(raw))?null:Number(raw));
        delete done[item.id]; persist(); updateAll();
      });
      rcell.addEventListener('click', e=>e.stopPropagation());
    } else if(item.right){
      rcell=document.createElement('div'); rcell.className='c-right '+(item.right.tint||'');
      rcell.innerHTML=item.right.value+(item.right.sub?`<small>${item.right.sub}</small>`:'');
    } else {
      rcell=document.createElement('div'); rcell.className='c-right plain'; rcell.textContent='—'; plain=true;
    }
    row.appendChild(rcell);

    if(!item.temp){
      row.addEventListener('click', ()=>{ done[item.id]=!isDone(item); persist(); updateAll(); });
    }
    refs.set(item.id,{ row, box, input, judgeEl, tgt, sub, rcell, plain });
    return row;
  }

  // ── Prep list DOM ──────────────────────────────────────────────────────────
  const PLUS='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
  function buildPrep(){
    const root=$('prepList'); root.innerHTML='';
    PREP.forEach(p=>{
      const row=document.createElement('div'); row.className='prep-row'+(prep[p.id]?' on':'');
      row.innerHTML = `
        <div class="box">${PLUS}</div>
        <div>
          <div class="p-nm">${p.name} <span class="prio ${p.prio}">${p.prio==='high'?'priority':'suggested'}</span></div>
          <div class="p-why">${p.why}</div>
        </div>
        <div class="p-qty">${p.qty}<small>${p.unit}</small></div>`;
      row.addEventListener('click', ()=>{ prep[p.id]=!prep[p.id]; persist(); row.classList.toggle('on',prep[p.id]); updatePrepProg(); });
      root.appendChild(row);
    });
    updatePrepProg();
  }
  function updatePrepProg(){
    const n=PREP.filter(p=>prep[p.id]).length;
    $('prepProg').textContent = n? `${n} queued → Prep board` : `${PREP.length} suggested`;
    $('prepProg').classList.toggle('done', n>0);
  }

  // ── Order list DOM ─────────────────────────────────────────────────────────
  function buildOrders(){
    const root=$('orderList'); root.innerHTML='';
    let lastSup=null;
    ORDERS.forEach(o=>{
      if(o.sup!==lastSup){
        lastSup=o.sup;
        const head=document.createElement('div'); head.className='ord-sup';
        head.innerHTML=`<span class="os-d" style="background:${o.dot}"></span>${o.sup}<span class="os-sum" data-sup-sum="${o.sup}"></span>`;
        root.appendChild(head);
      }
      const st=order[o.id];
      const row=document.createElement('div'); row.className='ord-row'+(st.on?' on':' off'); row.dataset.id=o.id;
      row.innerHTML = `
        <div class="box" data-role="toggle">${PLUS.replace('stroke-width="3"','stroke-width="3"')}</div>
        <div>
          <div class="o-nm">${o.name}${o.flag?`<span class="flag">${o.flag}</span>`:''}</div>
          <div class="o-par">on hand <b>${fmt(o.onhand)}</b> / par <b>${o.par}</b> ${o.unit}</div>
        </div>
        <div class="stepper" data-role="stepper">
          <button data-d="-1">−</button>
          <span class="qv"><span class="qn">${st.qty}</span> <small>${o.unit}</small></span>
          <button data-d="1">+</button>
        </div>
        <div class="o-cost">${money(st.qty*o.price)}</div>`;
      row.querySelector('[data-role="toggle"]').addEventListener('click', ()=>{
        st.on=!st.on; persist(); row.classList.toggle('on',st.on); row.classList.toggle('off',!st.on); updateOrders();
      });
      row.querySelectorAll('[data-role="stepper"] button').forEach(b=>{
        b.addEventListener('click', ()=>{
          st.qty=Math.max(0, st.qty + (+b.dataset.d)*o.step);
          if(st.qty===0) st.qty = o.step;
          persist();
          row.querySelector('.qn').textContent=st.qty;
          row.querySelector('.o-cost').textContent=money(st.qty*o.price);
          updateOrders();
        });
      });
      root.appendChild(row);
    });
    updateOrders();
  }
  function updateOrders(){
    const active=ORDERS.filter(o=>order[o.id].on);
    const total=active.reduce((s,o)=>s+order[o.id].qty*o.price,0);
    const sups=new Set(active.map(o=>o.sup));
    $('ordCount').textContent=active.length;
    $('ordSups').textContent=sups.size;
    $('ordTotal').textContent=money(total);
    // per-supplier subtotal
    document.querySelectorAll('[data-sup-sum]').forEach(el=>{
      const s=el.dataset.supSum;
      const sub=ORDERS.filter(o=>o.sup===s&&order[o.id].on).reduce((a,o)=>a+order[o.id].qty*o.price,0);
      el.textContent = sub? money(sub) : '—';
    });
    const btn=$('ordBtn');
    if(btn.dataset.sent!=='1'){
      btn.disabled = active.length===0;
      btn.style.opacity = active.length===0? '0.45':'1';
    }
  }
  $('ordBtn').addEventListener('click', function(){
    if(this.dataset.sent==='1') return;
    const active=ORDERS.filter(o=>order[o.id].on);
    if(!active.length) return;
    const sups=new Set(active.map(o=>o.sup)).size;
    this.dataset.sent='1'; this.classList.add('sent');
    this.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg> '+sups+' draft PO'+(sups>1?'s':'')+' created';
    setTimeout(()=>{ this.classList.remove('sent'); this.dataset.sent=''; this.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Draft orders'; updateOrders(); }, 2600);
  });

  // ── Reactive update for checklist + gate ──────────────────────────────────
  const C=2*Math.PI*44;
  const ringFill=$('ringFill'); ringFill.setAttribute('stroke-dasharray', C.toFixed(2));

  function updateAll(){
    const all=allItems();
    const total=all.length;
    const doneCount=all.filter(isDone).length;
    const blockers=all.filter(isBlocking);
    const pct=total?Math.round(doneCount/total*100):0;
    const ready=total>0 && doneCount===total;

    all.forEach(it=>{
      const r=refs.get(it.id); if(!r) return;
      const d=isDone(it), blk=isBlocking(it);
      r.row.classList.toggle('done',d);
      r.row.classList.toggle('blocking',blk);
      if(it.temp){
        const j=judge(it);
        if(document.activeElement!==r.input){ const v=temps[it.id]; r.input.value=(v==null||Number.isNaN(v))?'':v; }
        r.input.classList.toggle('ok', j.tint==='ok');
        r.input.classList.toggle('bad', j.tint==='bad');
        r.judgeEl.className='temp-judge '+j.tint;
        r.tgt.textContent = j.tint==='neutral'?'':(it.temp.max!==undefined?`≤${it.temp.max}°`:`≥${it.temp.min}°`);
        r.sub.textContent=j.sub;
      } else if(r.plain){
        r.rcell.textContent = d?'✓':'—';
      }
    });

    document.querySelectorAll('.prog[data-sec]').forEach(p=>{
      const its=DATA[p.dataset.sec];
      const d=its.filter(isDone).length;
      p.textContent=`${d} / ${its.length}`;
      p.classList.toggle('done', d===its.length);
    });

    $('ccChecks').textContent=doneCount+' / '+total;
    $('ccBlock').textContent=blockers.length;
    $('closeBandN').textContent=`${doneCount} / ${total} · SAVED ON THIS DEVICE`;
    $('footState').textContent=`END-OF-DAY DRAFT · ${doneCount} OF ${total} CHECKS · ${ready?'READY TO SIGN OFF':'AWAITING SIGN-OFF'}`;

    $('ringPct').textContent=pct;
    ringFill.style.strokeDashoffset=(C*(1-pct/100)).toFixed(2);
    ringFill.setAttribute('stroke', ready?'#16a34a':(blockers.length?'#dc2626':'#d97706'));

    const gateBtn=$('gateBtn'), gateTitle=$('gateTitle'), gateSub=$('gateSub');
    if(ready){
      gateBtn.classList.add('ready'); gateBtn.disabled=false;
      gateTitle.textContent='Ready to close';
      gateSub.textContent='Every close-down check is done. Sign off the day.';
    } else if(blockers.length===0){
      gateBtn.classList.remove('ready'); gateBtn.disabled=true;
      gateTitle.textContent='Almost closed';
      gateSub.textContent=`${total-doneCount} check${total-doneCount>1?'s':''} left — no blockers, finish the list.`;
    } else {
      gateBtn.classList.remove('ready'); gateBtn.disabled=true;
      gateTitle.textContent='Not ready to close';
      gateSub.textContent=`${blockers.length} blocker${blockers.length>1?'s':''} must clear before the day can close.`;
    }

    $('blkCount').textContent=blockers.length;
    const bl=$('blkList');
    bl.innerHTML = blockers.length? '' : '<div class="blk-row" style="color:var(--green-text);">No blockers — close-down is clear.</div>';
    blockers.forEach(b=>{
      const status=b.temp?judge(b).value:(b.right?b.right.value:'open');
      bl.insertAdjacentHTML('beforeend', `<div class="blk-row"><span class="bd" style="background:var(--red);"></span><span class="bnm">${b.title}</span><span class="bst">${status}</span></div>`);
    });
  }

  // ── Gate: close the day ────────────────────────────────────────────────────
  function closeDay(){
    const btn=$('gateBtn');
    if(btn.disabled) return;
    btn.innerHTML='<span class="gb-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></span> Day closed — see you tomorrow';
    $('gateSub').textContent='Actuals filed · food-safety log saved · tomorrow\u2019s Pass updated.';
    setTimeout(()=>{ window.location.href='Pass.html'; }, 1100);
  }
  $('gateBtn').addEventListener('click', closeDay);

  // ── Handover note ──────────────────────────────────────────────────────────
  const ho=$('handover'); ho.value=handover;
  ho.addEventListener('input', ()=>{
    handover=ho.value; persist();
    $('handoverMeta').textContent = handover.trim()? 'Saved · will show on tomorrow\u2019s Pass · Josh M.' : 'Saved to tomorrow\u2019s Pass · Josh M.';
  });

  // ── Header buttons ─────────────────────────────────────────────────────────
  $('printBtn').addEventListener('click', ()=>window.print());
  $('emailBtn').addEventListener('click', function(){
    const orig=this.innerHTML;
    this.innerHTML='<span class="ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span> Sent to owner';
    setTimeout(()=>{ this.innerHTML=orig; }, 2200);
  });

  // ── Keys ───────────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e=>{
    if((e.metaKey||e.ctrlKey) && e.key==='Enter'){ e.preventDefault(); closeDay(); }
    else if((e.metaKey||e.ctrlKey) && (e.key==='p'||e.key==='P')){ /* let browser print */ }
    else if(e.key==='Escape' && document.activeElement.tagName!=='INPUT' && document.activeElement.tagName!=='TEXTAREA'){ window.location.href='Pass.html'; }
  });

  // ── Clock ──────────────────────────────────────────────────────────────────
  function tickClock(){
    const d=new Date();
    $('nowClock').textContent=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  buildSections(); buildPrep(); buildOrders(); updateAll(); tickClock();
  setInterval(tickClock, 30000);
})();
