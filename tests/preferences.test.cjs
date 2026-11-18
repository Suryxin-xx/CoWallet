'use strict';
const assert = require('node:assert/strict');
const P = require('../preferences.js');

let checks = 0;
function test(name, run) { run(); checks++; console.log('✓ ' + name); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fakeDocument() {
  const variables = {};
  return { documentElement: { dataset: {}, style: { setProperty(name, value) { variables[name] = value; } } }, variables };
}
function rejects(change) { const p = P.defaultPreferences(); change(p); assert.throws(() => P.normalizePreferences(p)); }
function luminance(color) {
  const rgb = color.slice(1).match(/../g).map(s => parseInt(s,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  return rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
}
function contrast(a,b) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }

test('defaults return independent nested objects and keep overview accessible', () => {
  const a=P.defaultPreferences(),b=P.defaultPreferences();
  assert.equal(a.version,1);assert.equal(a.theme,'sage');assert.equal(a.fontScale,1);assert.equal(a.sidebar.overview,true);
  a.sidebar.income=false;a.dashboard.kpis=false;
  assert.equal(b.sidebar.income,true);assert.equal(b.dashboard.kpis,true);
});
test('all five light themes apply complete palettes with stable financial colors', () => {
  const surfaces=new Set();
  for(const theme of ['sage','ocean','sand','plum','graphite']) {
    const p=P.defaultPreferences();p.theme=theme;
    const doc=fakeDocument(),out=P.applyPreferences(p,doc),v=doc.variables;
    assert.equal(out.theme,theme);assert.equal(doc.documentElement.dataset.theme,theme);
    assert.equal(doc.documentElement.dataset.density,'comfortable');assert.equal(v['--font-scale'],'1');
    for(const key of ['--bg','--card','--ink','--muted','--line','--green','--dark','--accent-soft','--accent-ink','--mint','--positive','--negative']) assert.match(v[key],/^#[0-9a-f]{6}$/);
    assert.equal(v['--positive'],'#247044');assert.equal(v['--negative'],'#b43e3e');assert.equal(v['color-scheme'],'light');
    assert(contrast(v['--ink'],v['--bg'])>=7);assert(contrast(v['--muted'],v['--card'])>=4.5);
    assert(contrast(v['--accent-ink'],v['--accent-soft'])>=4.5);assert(contrast('#ffffff',v['--dark'])>=7);
    assert(contrast(v['--negative'],v['--card'])>=4.5);assert(contrast(v['--positive'],v['--card'])>=4.5);
    surfaces.add(v['--bg']);
  }
  assert.equal(surfaces.size,5);
});
test('font scale permits both bounds and compact density', () => {
  for(const scale of [.875,1.375]) { const p=P.defaultPreferences();p.fontScale=scale;p.density='compact';const doc=fakeDocument();P.applyPreferences(p,doc);assert.equal(doc.variables['--font-scale'],String(scale));assert.equal(doc.documentElement.dataset.density,'compact'); }
});
test('normalization copies flags and supports hidden optional modules', () => {
  const p=P.defaultPreferences();for(const key of Object.keys(p.sidebar))if(key!=='overview')p.sidebar[key]=false;
  for(const key of Object.keys(p.dashboard))p.dashboard[key]=false;
  const result=P.normalizePreferences(p);assert.equal(result.sidebar.overview,true);assert.equal(result.sidebar.housing,false);
  result.sidebar.income=true;assert.equal(p.sidebar.income,false);
});
test('overview cannot be hidden even if every optional navigation item is hidden', () => rejects(p=>{for(const key of Object.keys(p.sidebar))p.sidebar[key]=false;}));
test('unknown top-level, sidebar and dashboard keys are rejected', () => {
  rejects(p=>p.network=true);rejects(p=>p.sidebar.settings=false);rejects(p=>p.dashboard.surprise=true);
  rejects(p=>Object.defineProperty(p,'hiddenUnknown',{value:true}));rejects(p=>p[Symbol('unknown')]=true);
});
test('required fields cannot be omitted', () => { rejects(p=>delete p.theme);rejects(p=>delete p.sidebar.monthly);rejects(p=>delete p.dashboard.goal); });
test('flags require booleans without coercion', () => { for(const v of [0,1,'true',null,[],{}]) { rejects(p=>p.sidebar.income=v);rejects(p=>p.dashboard.kpis=v); } });
test('invalid theme, density and versions are rejected', () => {
  for(const v of ['dark','__proto__','constructor','sage; color:red',null,{}])rejects(p=>p.theme=v);
  for(const v of ['dense','comfortable ',null,1])rejects(p=>p.density=v);
  for(const v of [0,2,'1',true])rejects(p=>p.version=v);
});
test('font scale rejects nonnumbers, nonfinite values and out-of-range values', () => {
  for(const v of [.8749,1.3751,0,-1,NaN,Infinity,-Infinity,'1',null,{}])rejects(p=>p.fontScale=v);
});
test('arrays and inherited or polluted records are rejected', () => {
  for(const value of [null,[],new Date(),Object.create(P.defaultPreferences())])assert.throws(()=>P.normalizePreferences(value));
  const p=P.defaultPreferences();p.sidebar=Object.assign(Object.create({hidden:true}),p.sidebar);assert.throws(()=>P.normalizePreferences(p));
  const parsed=JSON.parse(JSON.stringify(P.defaultPreferences()).replace('"version":1','"version":1,"__proto__":{"polluted":true}'));
  assert.throws(()=>P.normalizePreferences(parsed));assert.equal({}.polluted,undefined);
});
test('invalid preferences never partly mutate the document', () => {
  const doc=fakeDocument(),p=P.defaultPreferences();p.fontScale=Infinity;
  assert.throws(()=>P.applyPreferences(p,doc));assert.deepEqual(doc.documentElement.dataset,{});assert.deepEqual(doc.variables,{});
});
test('apply returns a normalized copy without requiring a browser', () => {
  const p=P.defaultPreferences(),result=P.applyPreferences(p);assert.deepEqual(result,p);assert.notEqual(result,p);
  assert.throws(()=>P.applyPreferences(p,{}));assert.deepEqual(P.normalizePreferences(clone(result)),result);
});

console.log('\n' + checks + ' preferences checks passed.');
