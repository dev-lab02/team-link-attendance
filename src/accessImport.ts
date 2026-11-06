import * as XLSX from 'xlsx'

export type ImportMember = { id:string; name:string; furigana:string; number:string; grade:string; group:string; school:string; gender:string; active:boolean; createdAt:string }
export type ImportSession = { id:string; date:string; title:string; createdAt:string }
export type ImportEntry = { sessionId:string; memberId:string; status:'present'|'absent'|'late'|'excused' }
export type ImportData = { version:1; members:ImportMember[]; sessions:ImportSession[]; entries:ImportEntry[] }
type Row = Record<string,unknown>
export type ImportResult = { data:ImportData; addedMembers:number; updatedMembers:number; addedSessions:number; addedEntries:number; skippedEntries:number; warnings:string[]; sourceRows:number }
const clean = (v:unknown) => String(v ?? '').trim().replace(/\s+/g,' ')
const key = (v:unknown) => clean(v).normalize('NFKC').replace(/\s/g,'').toLowerCase()
const id = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const cell = (r:Row, ...names:string[]) => { const col = Object.keys(r).find(k=>names.some(n=>key(n)===key(k))); return col ? r[col] : '' }
const normDate = (v:unknown):string => {
  if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`
  if (typeof v==='number') { const d=XLSX.SSF.parse_date_code(v); if(d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}` }
  const s=clean(v).replace(/[年月]/g,'/').replace(/日/g,'').replace(/[.\-]/g,'/').split(' ')[0]
  const m=s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (!m) return ''
  const y=Number(m[1]),mo=Number(m[2]),day=Number(m[3]);const dt=new Date(y,mo-1,day)
  return dt.getFullYear()===y&&dt.getMonth()===mo-1&&dt.getDate()===day ? `${y}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}` : ''
}
const status = (v:unknown):ImportEntry['status']|null => {
 const s=key(v)
 if(['出席','出','〇','○','◯','1','present'].includes(s))return 'present'
 if(['欠席','欠','×','✕','2','absent'].includes(s))return 'absent'
 if(['遅刻','遅','3','late'].includes(s))return 'late'
 if(['公欠','公','4','excused'].includes(s))return 'excused'
 return null
}
const read = async (file:File, required:string[]):Promise<Row[]> => {
 const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true})
 const sheet=workbook.Sheets[workbook.SheetNames[0]]
 if(!sheet)throw Error(`${file.name}: シートがありません`)
 const rows=XLSX.utils.sheet_to_json<Row>(sheet,{defval:'',raw:true})
 const headers=(XLSX.utils.sheet_to_json<(string|number)[]>(sheet,{header:1,range:0})[0]||[]).map((x: string | number) => key(x))
 const missing=required.filter(x=>!headers.includes(key(x)))
 if(missing.length)throw Error(`${file.name}: 必須列がありません（${missing.join('、')}）`)
 return rows
}
const sameMember=(a:ImportMember,b:Pick<ImportMember,'name'|'furigana'|'group'>) => key(a.name)===key(b.name)&&key(a.group)===key(b.group)&&(!key(a.furigana)||!key(b.furigana)||key(a.furigana)===key(b.furigana))
export async function importAccessFiles(current:ImportData, memberFile?:File, historyFile?:File):Promise<ImportResult>{
 if(!memberFile&&!historyFile)throw Error('Excelファイルを選択してください')
 const master=memberFile?await read(memberFile,['名前','ふりがな','学年','グループ','出身校','性別']):[]
 const history=historyFile?await read(historyFile,['日付','練習名','グループ','背番号','選手名','ふりがな','学年','出身校','性別','出欠']):[]
 if(!master.length&&!history.length)throw Error('データ行がありません。添付のExcelは見出し行のみです。Accessから実データを含めて再エクスポートしてください。')
 const result:ImportData={...current,version:1,members:current.members.map(x=>({...x})),sessions:current.sessions.map(x=>({...x})),entries:current.entries.map(x=>({...x}))}
 const warnings:string[]=[];let addedMembers=0,updatedMembers=0,addedSessions=0,addedEntries=0,skippedEntries=0
 const upsert=(source:Partial<ImportMember>&{name:string},row:number,kind:string):ImportMember|null=>{
  const incoming={name:clean(source.name),furigana:clean(source.furigana),group:clean(source.group)}
  if(!incoming.name){warnings.push(`${kind} ${row}行目: 選手名が空欄`);return null}
  const matches=result.members.filter(m=>sameMember(m,incoming))
  if(matches.length>1){warnings.push(`${kind} ${row}行目: 同名・同グループの候補が複数あるためスキップ（${incoming.name}）`);return null}
  if(matches.length===1){const m=matches[0];let changed=false
   for(const field of ['furigana','number','grade','group','school','gender'] as const){const value=clean(source[field]);if(value&&!clean(m[field])){m[field]=value;changed=true}}
   if(changed)updatedMembers++;return m
  }
  const m:ImportMember={id:id(),name:incoming.name,furigana:incoming.furigana,number:clean(source.number),grade:clean(source.grade),group:incoming.group,school:clean(source.school),gender:clean(source.gender),active:true,createdAt:now()}
  result.members.push(m);addedMembers++;return m
 }
 for(let i=0;i<master.length;i++){
  const r=master[i];upsert({name:clean(cell(r,'名前')),furigana:clean(cell(r,'ふりがな')),grade:clean(cell(r,'学年')),group:clean(cell(r,'グループ')),school:clean(cell(r,'出身校')),gender:clean(cell(r,'性別'))},i+2,'メンバーマスタ')
 }
 for(let i=0;i<history.length;i++){
  const r=history[i];const date=normDate(cell(r,'日付'));const title=clean(cell(r,'練習名'))
  if(!date||!title){warnings.push(`出欠履歴 ${i+2}行目: 日付または練習名が不正`);skippedEntries++;continue}
  const member=upsert({name:clean(cell(r,'選手名')),furigana:clean(cell(r,'ふりがな')),number:clean(cell(r,'背番号')),grade:clean(cell(r,'学年')),group:clean(cell(r,'グループ')),school:clean(cell(r,'出身校')),gender:clean(cell(r,'性別'))},i+2,'出欠履歴')
  if(!member){skippedEntries++;continue}
  const rawStatus=cell(r,'出欠');const st=status(rawStatus)
  if(!st){if(clean(rawStatus)&&!['未入力','未','-'].includes(clean(rawStatus)))warnings.push(`出欠履歴 ${i+2}行目: 未対応の出欠値「${clean(rawStatus)}」`);skippedEntries++;continue}
  let session=result.sessions.find(s=>s.date===date&&key(s.title)===key(title))
  if(!session){session={id:id(),date,title,createdAt:now()};result.sessions.push(session);addedSessions++}
  const old=result.entries.find(e=>e.sessionId===session.id&&e.memberId===member.id)
  if(old){if(old.status!==st)warnings.push(`出欠履歴 ${i+2}行目: 既存記録と異なるため変更しません（${date} ${member.name}）`);skippedEntries++;continue}
  result.entries.push({sessionId:session.id,memberId:member.id,status:st});addedEntries++
 }
 return {data:result,addedMembers,updatedMembers,addedSessions,addedEntries,skippedEntries,warnings,sourceRows:master.length+history.length}
}
