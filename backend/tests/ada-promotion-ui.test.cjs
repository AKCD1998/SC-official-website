const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../public/promotions/portal.js'),'utf8');
async function portal(mode){
  const nodes=new Map();
  function node(){return {value:'250',hidden:false,disabled:false,textContent:'',children:[],append(child){this.children.push(child);},replaceChildren(){this.children=[];},scrollIntoView(){}};}
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const fetch=jest.fn(async url=>({ok:true,json:async()=>String(url).includes('/active')?{pointsMode:mode,promotions:[],serverTime:'2026-11-02T02:00:00Z'}:
    String(url).includes('/quote')?{awardedPoints:10,basePoints:10,bahtPerPoint:25,serverTime:'2026-11-02T02:00:00Z'}:{pointsMode:mode,promotions:[]}}));
  const context=vm.createContext({document:{getElementById:get,createElement:node,addEventListener(){},hidden:false},fetch,URLSearchParams,
    AbortSignal,location:{hash:'',search:'',pathname:'/sccrm/promotions/admin'},history:{replaceState(){}},setInterval(){}});
  vm.runInContext(source,context);await new Promise(setImmediate);await new Promise(setImmediate);
  return {get,fetch,context};
}
test('Ada mode displays its source without asking the retired local preview endpoint or promising 25-baht awards',async()=>{
  const {get,fetch,context}=await portal('ada-primary');
  expect(fetch.mock.calls.some(([url])=>url.includes('/quote'))).toBe(false);
  expect(get('quoteForm').hidden).toBe(true);expect(get('quoteHint').hidden).toBe(true);expect(get('saveForm').hidden).toBe(true);
  expect(get('quote').textContent).toContain('Ada');expect(get('status').textContent).toContain('โดยไม่เพิ่มแต้มซ้ำ');
  await vm.runInContext('loadAdmin()',context);
  expect(get('allPromotions').children[0].textContent).toContain('Ada');
  expect(get('adminModeNotice').hidden).toBe(false);
});
test('legacy mode preserves the central preview and existing admin form',async()=>{
  const {get,fetch}=await portal('sccrm');
  expect(fetch.mock.calls.some(([url])=>url.includes('/quote'))).toBe(true);
  expect(get('quoteForm').hidden).toBe(false);expect(get('quoteHint').hidden).toBe(false);expect(get('saveForm').hidden).toBe(false);
  expect(get('quote').textContent).toContain('10');expect(get('status').textContent).toContain('25');
});
