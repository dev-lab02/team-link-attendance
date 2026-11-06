import { importAccessFiles, type ImportResult } from './accessImport'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, CalendarDays, Check, ChevronRight, ClipboardCheck, Download, FileUp, LayoutDashboard, Plus, Search, ShieldCheck, Trash2, Users, X } from 'lucide-react'

type Status = 'present' | 'absent' | 'late' | 'excused'
type Member = { id: string; name: string; furigana: string; number: string; grade: string; group: string; school: string; gender: string; active: boolean; createdAt: string }
type Session = { id: string; date: string; title: string; createdAt: string }
type Entry = { sessionId: string; memberId: string; status: Status; gradeAtTime?: string }
type RunRecord = { sessionId: string; memberId: string; gymId: string; laps: number; seconds: number | null; retired: boolean; gradeAtTime?: string }
type Gym = { id: string; name: string; meters: number }
type Data = { version: 1; members: Member[]; sessions: Session[]; entries: Entry[]; gyms?: Gym[]; runs?: RunRecord[] }
type Page = 'dashboard' | 'attendance' | 'members' | 'reports' | 'times' | 'timeReports' | 'settings'
type ReportTab = 'day' | 'person'
const STORAGE_KEY = 'team-link-attendance-v1'
const STATUS: { key: Status; label: string; short: string }[] = [
  { key: 'present', label: '出席', short: '出' }, { key: 'absent', label: '欠席', short: '欠' },
  { key: 'late', label: '遅刻', short: '遅' }, { key: 'excused', label: '公欠', short: '公' }
]
const normalizeMember = (m: Member): Member => ({ ...m, furigana: m.furigana ?? '', grade: m.active ? (m.grade ?? '') : '', school: m.active ? (m.school ?? '') : '', gender: m.gender ?? '' })
const normalizeData = (d: Data): Data => ({ ...d, members: d.members.map(normalizeMember), gyms: Array.isArray(d.gyms) ? d.gyms : [], runs: Array.isArray(d.runs) ? d.runs : [] })
const empty: Data = { version: 1, members: [], sessions: [], entries: [], gyms: [], runs: [] }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
const dateLabel = (d: string) => d ? d.replaceAll('-', '/') : ''
const uid = () => crypto.randomUUID()
const isStatus = (v: unknown): v is Status => STATUS.some(s => s.key === v)
function validData(raw: unknown): raw is Data {
  if (!raw || typeof raw !== 'object') return false
  const d = raw as Partial<Data>
  return d.version === 1 && Array.isArray(d.members) && Array.isArray(d.sessions) && Array.isArray(d.entries)
    && d.members.every(m => m && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.number === 'string' && typeof m.group === 'string' && typeof m.active === 'boolean')
    && d.sessions.every(s => s && typeof s.id === 'string' && typeof s.date === 'string' && typeof s.title === 'string')
    && d.entries.every(e => e && typeof e.sessionId === 'string' && typeof e.memberId === 'string' && isStatus(e.status))
    && (d.gyms === undefined || (Array.isArray(d.gyms) && d.gyms.every(g=>typeof g.id==='string'&&typeof g.name==='string'&&typeof g.meters==='number')))
    && (d.runs === undefined || (Array.isArray(d.runs) && d.runs.every(r=>typeof r.sessionId==='string'&&typeof r.memberId==='string'&&typeof r.gymId==='string'&&typeof r.laps==='number'&&(r.seconds===null||typeof r.seconds==='number')&&typeof r.retired==='boolean')))
}
function readData(): Data { try { const raw = localStorage.getItem(STORAGE_KEY); const d: unknown = raw ? JSON.parse(raw) : null; return validData(d) ? normalizeData(d) : empty } catch { return empty } }
function download(content: string, filename: string, mime: string) { const url = URL.createObjectURL(new Blob([content], {type:mime})); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500) }
function csv(rows: (string | number)[][]) { return '\ufeff' + rows.map(row => row.map(cell => `"${String(cell).replaceAll('"','""')}"`).join(',')).join('\r\n') }
// 記録時の学年を優先する。旧データは学年と練習日から推定し、卒団等で判別不能なら「—」。
function schoolYear(date: string): number { const y=Number(date.slice(0,4)); const m=Number(date.slice(5,7)); return y-(m>=4?0:1) }
function historicalGrade(snapshot: string | undefined, member: Member | undefined, date: string): string {
  if (snapshot !== undefined) return gradeLabel(snapshot)
  if (!member?.active || !member.grade || !date) return '—'
  const match=member.grade.trim().match(/^(小学|中学|高校)?([1-9])年?$/)
  if (!match) return gradeLabel(member.grade)
  const base=Number(match[2]); const delta=schoolYear(today())-schoolYear(date)
  const past=base-delta
  if (past<1 || past>6 || (match[1] && match[1]!=='小学' && past>3)) return '—'
  return `${match[1]||''}${past}年`
}
function GradeName({grade,member}:{grade:string;member:Member|undefined}) {
  return <div className="grade-name-cell"><span className="grade-name-grade">{grade}</span><div className="name-with-furigana"><small>{member?.furigana||'　'}</small><strong>{member?.name||'不明'}</strong></div></div>
}
const orderMembers = (a: Member, b: Member) => a.group.localeCompare(b.group, 'ja') || (Number(a.number) || 999) - (Number(b.number) || 999) || a.name.localeCompare(b.name,'ja')

export default function App() {
  const [data, setData] = useState<Data>(readData)
  const [page, setPage] = useState<Page>('dashboard')
  const [reportTab, setReportTab] = useState<ReportTab>('day')
  const [timeTab, setTimeTab] = useState<'person'|'day'|'all'>('person')
  const [timeMember, setTimeMember] = useState('')
  const [timeSession, setTimeSession] = useState('')
  const [timeGym, setTimeGym] = useState('')
  const [timeLaps, setTimeLaps] = useState(5)
  const [selectedSession, setSelectedSession] = useState('')
  const [selectedMember, setSelectedMember] = useState('')
  const [personDetailOpen, setPersonDetailOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('all')
  const [memberModal, setMemberModal] = useState<Member | 'new' | null>(null)
  const [sessionModal, setSessionModal] = useState(false)
  const [notice, setNotice] = useState('')
  const [saveError, setSaveError] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const masterRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<HTMLInputElement>(null)
  const [masterFile, setMasterFile] = useState<File | undefined>()
  const [historyFile, setHistoryFile] = useState<File | undefined>()
  const [accessPreview, setAccessPreview] = useState<ImportResult | null>(null)
  const [accessBusy, setAccessBusy] = useState(false)
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); setSaveError(false) } catch { setSaveError(true) } }, [data])
  useEffect(() => { if (notice) { const id = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(id) } }, [notice])
  const sessions = useMemo(() => [...data.sessions].sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [data.sessions])
  const members = useMemo(() => [...data.members].sort(orderMembers), [data.members])
  const groups = useMemo(() => [...new Set(members.map(m => m.group).filter(Boolean))].sort((a,b) => a.localeCompare(b,'ja')), [members])
  const activeMembers = useMemo(() => members.filter(m => m.active), [members])
  const currentId = selectedSession && data.sessions.some(s => s.id === selectedSession) ? selectedSession : sessions[0]?.id || ''
  const currentSession = data.sessions.find(s => s.id === currentId)
  const runSessionId = timeSession && data.sessions.some(s=>s.id===timeSession) ? timeSession : sessions[0]?.id || ''
  const runs = data.runs || []
  const gyms = data.gyms || []
  const runGymId = timeGym && gyms.some(g=>g.id===timeGym) ? timeGym : gyms[0]?.id || ''
  const runMemberId = timeMember && members.some(m=>m.id===timeMember) ? timeMember : members[0]?.id || ''
  const runEligible = members.filter(m => {const st = getRunAttendance(data.entries,runSessionId,m.id);return st!=='absent' && st!=='excused' && (m.active || !!st)})
  const runFor = (sid:string,mid:string) => runs.find(r=>r.sessionId===sid && r.memberId===mid)
  const saveRun = (sid:string,mid:string,changes:Partial<RunRecord>) => setData(d=>{const old=(d.runs||[]).find(r=>r.sessionId===sid&&r.memberId===mid);const updated:RunRecord={sessionId:sid,memberId:mid,gymId:runGymId,laps:timeLaps,seconds:null,retired:false,gradeAtTime:historicalGrade(undefined,d.members.find(m=>m.id===mid),d.sessions.find(s=>s.id===sid)?.date||''),...old,...changes};return {...d,runs:[...(d.runs||[]).filter(r=>!(r.sessionId===sid&&r.memberId===mid)),updated]}})
  const currentMemberId = selectedMember && data.members.some(m => m.id === selectedMember) ? selectedMember : members[0]?.id || ''
  const entryMap = useMemo(() => new Map(data.entries.map(e => [`${e.sessionId}:${e.memberId}`,e.status])), [data.entries])
  const getStatus = (sessionId: string, memberId: string) => entryMap.get(`${sessionId}:${memberId}`)
  const getCounts = (sessionId: string) => { const counts: Record<Status,number> = {present:0,absent:0,late:0,excused:0}; let unmarked=0; for (const m of activeMembers) { const status = getStatus(sessionId,m.id); if(status) counts[status]++; else unmarked++ } return {...counts,unmarked} }
  const counts = currentId ? getCounts(currentId) : {present:0,absent:0,late:0,excused:0,unmarked:activeMembers.length}
  const updateStatus = (sessionId: string, memberId: string, status: Status) => setData(prev => ({...prev, entries: [...prev.entries.filter(e => !(e.sessionId === sessionId && e.memberId === memberId)),{sessionId,memberId,status,gradeAtTime:prev.entries.find(e=>e.sessionId===sessionId&&e.memberId===memberId)?.gradeAtTime??historicalGrade(undefined,prev.members.find(m=>m.id===memberId),prev.sessions.find(s=>s.id===sessionId)?.date||'')}] }))
  // 出欠入力を開いた際、未入力の在籍メンバーだけ出席で初期化する。既存の欠席等は変更しない。
  useEffect(() => {
    if (page !== 'attendance' || !currentId) return
    setData(prev => {
      const existing = new Set(prev.entries.filter(e => e.sessionId === currentId).map(e => e.memberId))
      const missing = prev.members.filter(m => m.active && !existing.has(m.id))
      return missing.length ? {...prev, entries:[...prev.entries,...missing.map(m => ({sessionId:currentId,memberId:m.id,status:'present' as Status,gradeAtTime:historicalGrade(undefined,m,prev.sessions.find(s=>s.id===currentId)?.date||'')}))]} : prev
    })
  }, [page,currentId,data.members,data.entries])
  const filteredMembers = members.filter(m => (groupFilter === 'all' || m.group === groupFilter) && (`${m.name} ${m.number} ${m.group}`).toLowerCase().includes(filter.toLowerCase()))
  const openPage = (p: Page) => { setPage(p); setFilter(''); setGroupFilter('all'); setPersonDetailOpen(false) }
  const removeSession = (id: string) => { if (!confirm('この練習日と出欠記録を削除しますか？この操作は元に戻せません。')) return; setData(d => ({...d,sessions:d.sessions.filter(s=>s.id!==id),entries:d.entries.filter(e=>e.sessionId!==id),runs:(d.runs||[]).filter(r=>r.sessionId!==id)})); setSelectedSession(''); setNotice('練習日を削除しました') }
  // 新年度更新：在籍中の小学1～5年生を進級し、6年生を卒団にする。
  // 卒団者と学年未設定・中高生・その他の選手は変更しない。
  const advanceSchoolYear = () => {
    const gradeOf = (value: string): number | null => {
      const normalized = value.trim().replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFF10))
      const match = normalized.match(/^(?:小学)?([1-6])年(?:生)?$/)
      return match ? Number(match[1]) : null
    }
    const graduating = data.members.filter(m => m.active && gradeOf(m.grade) === 6)
    const advancing = data.members.filter(m => m.active && (gradeOf(m.grade) ?? 0) >= 1 && (gradeOf(m.grade) ?? 0) <= 5)
    if (!graduating.length && !advancing.length) {
      alert('進級・卒団の対象となる在籍中の小学1～6年生がいません。')
      return
    }
    if (!confirm(`新年度の学年更新を実行しますか？\n\n進級：${advancing.length}名\n卒団：${graduating.length}名\n\n卒団者の学年・出身校は空欄にし、出欠・タイム履歴は残します。\n実行前にJSONバックアップをダウンロードします。\n※同じ年度に2回実行しないでください。`)) return
    // バックアップを先にダウンロードしてからデータを更新する。
    download(JSON.stringify(data, null, 2), `出欠管理_新年度更新前_${today()}.json`, 'application/json')
    setData(prev => ({
      ...prev,
      entries: prev.entries.map(e=>({...e,gradeAtTime:e.gradeAtTime??historicalGrade(undefined,prev.members.find(m=>m.id===e.memberId),prev.sessions.find(t=>t.id===e.sessionId)?.date||'')})),
      runs: (prev.runs||[]).map(r=>({...r,gradeAtTime:r.gradeAtTime??historicalGrade(undefined,prev.members.find(m=>m.id===r.memberId),prev.sessions.find(t=>t.id===r.sessionId)?.date||'')})),
      members: prev.members.map(m => {
        if (!m.active) return m
        const grade = gradeOf(m.grade)
        if (grade === 6) return {...m, active:false, grade:'', school:''}
        if (grade !== null && grade >= 1 && grade <= 5) {
          const prefix = m.grade.trim().startsWith('小学') ? '小学' : ''
          return {...m, grade:`${prefix}${grade+1}年`}
        }
        return m
      })
    }))
    setNotice(`新年度更新：${advancing.length}名が進級、${graduating.length}名が卒団しました`)
  }
  const exportBackup = () => { download(JSON.stringify(data,null,2),`出欠管理_全データ_${today()}.json`,'application/json'); setNotice('バックアップを保存しました') }
  const importBackup = async (file?: File) => { if (!file) return; try { const raw: unknown = JSON.parse(await file.text()); if (!validData(raw)) throw new Error('形式が正しくありません'); if (!confirm('現在の全データを置き換えます。事前にバックアップを保存しましたか？')) return; setData(normalizeData(raw)); setSelectedSession(''); setSelectedMember(''); setPersonDetailOpen(false); setNotice('バックアップを復元しました') } catch { alert('読み込めませんでした。TEAM LINK出欠管理のバックアップJSONを選択してください。') } finally { if (importRef.current) importRef.current.value = '' } }
  const previewAccess = async () => {
    setAccessBusy(true);setAccessPreview(null)
    try { setAccessPreview(await importAccessFiles(data,masterFile,historyFile)) }
    catch (err) { alert(err instanceof Error ? err.message : 'Excelを読み込めませんでした') }
    finally { setAccessBusy(false) }
  }
  const applyAccess = () => {
    if(!accessPreview)return
    if(!confirm(`現在のデータを残して追加します。\nメンバー追加: ${accessPreview.addedMembers}人\n練習日追加: ${accessPreview.addedSessions}件\n出欠追加: ${accessPreview.addedEntries}件\n取り込みますか？`))return
    // プレビュー後に通常の出欠入力が行われていないことを前提に、直前のデータをバックアップします。
    download(JSON.stringify(data,null,2),`Access移行前バックアップ_${today()}.json`,'application/json')
    setData(accessPreview.data);setAccessPreview(null);setMasterFile(undefined);setHistoryFile(undefined)
    if(masterRef.current)masterRef.current.value='';if(historyRef.current)historyRef.current.value=''
    setNotice('Accessデータを取り込みました。移行前バックアップも保存しました')
  }
  const exportCsv = () => { const rows: (string|number)[][] = [['日付','練習名','グループ','背番号','選手名','ふりがな','学年','出身校','性別','出欠']]; for (const s of [...sessions].reverse()) for (const m of members) { const st = getStatus(s.id,m.id); rows.push([s.date,s.title,m.group,m.number,m.name,m.furigana,m.grade,m.school,m.gender,STATUS.find(x=>x.key===st)?.label ?? '未入力']) } download(csv(rows),`出欠一覧_${today()}.csv`,'text/csv;charset=utf-8'); setNotice('CSVを保存しました') }
  const navigation: {key:Page;label:string;icon:typeof Activity}[] = [
    {key:'dashboard',label:'ホーム',icon:LayoutDashboard},{key:'attendance',label:'出欠入力',icon:ClipboardCheck},
    {key:'times',label:'タイム入力',icon:Activity},{key:'reports',label:'出欠照会',icon:CalendarDays},{key:'timeReports',label:'タイム照会',icon:Activity},{key:'settings',label:'データ管理',icon:ShieldCheck}
  ]
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Activity size={25}/></div><div><div className="brand-name">TEAM LINK</div><div className="brand-sub">ATTENDANCE MANAGER</div></div></div>
      <div className="sidebar-caption">MENU</div>
      <nav className="nav">{navigation.map(n => <button key={n.key} className={`nav-item ${page===n.key?'active':''}`} onClick={()=>openPage(n.key)}><n.icon size={19}/><span>{n.label}</span></button>)}</nav>
      <div className="sidebar-foot"><div className="online-dot"/> ローカル保存モード <small>この端末内に保存されます</small></div>
    </aside>
    <div className="main-area">
      <header className="topbar"><div className="topbar-brand">TEAM LINK <span>/ 出欠管理</span></div><div className="topbar-right"><span className="today-pill"><CalendarDays size={15}/>{dateLabel(today())}</span></div></header>
      <main className="content">
        {saveError && <div className="warning">保存容量などの問題でデータを保存できません。バックアップを取り、端末の空き容量をご確認ください。</div>}
        {page==='dashboard' && <>
          <div className="page-heading"><div><div className="eyebrow">OVERVIEW</div><h1>出欠管理ダッシュボード</h1><p>チームの出欠状況をひと目で確認できます。</p></div><button className="btn primary" onClick={()=>setSessionModal(true)}><Plus size={18}/>練習日を追加</button></div>
          <div className="metric-grid">
            <Metric label="登録メンバー" value={activeMembers.length} suffix="名" icon={<Users size={20}/>} tone="blue" />
            <Metric label="登録練習日" value={sessions.length} suffix="回" icon={<CalendarDays size={20}/>} tone="purple" />
            <Metric label="最新の出席" value={sessions.length?getCounts(sessions[0].id).present:0} suffix="名" icon={<Check size={20}/>} tone="green" />
            <Metric label="最新の未入力" value={sessions.length?getCounts(sessions[0].id).unmarked:0} suffix="名" icon={<ClipboardCheck size={20}/>} tone="orange" />
          </div>
          <div className="dashboard-grid"><section className="panel"><div className="panel-head"><div><h2>最近の練習日</h2><p>日付を選択すると出欠入力へ移動します</p></div></div>
            {sessions.length===0 ? <Empty title="練習日がまだありません" detail="練習日を追加して出欠記録を始めましょう。"/> : <div className="session-list">{sessions.slice(0,6).map(s=>{const c=getCounts(s.id);return <button className="session-row" key={s.id} onClick={()=>{setSelectedSession(s.id);openPage('attendance')}}><div className="session-date"><strong>{s.date.slice(8)}</strong><small>{s.date.slice(0,7).replace('-','/')}</small></div><div className="session-info"><strong>{s.title}</strong><span>出席 {c.present} ・ 欠席 {c.absent} ・ 遅刻 {c.late} ・ 公欠 {c.excused}</span></div><div className="session-count">{activeMembers.length-c.unmarked}/{activeMembers.length} <ChevronRight size={17}/></div></button>})}</div>}
          </section><section className="panel quick-panel"><div className="panel-head"><h2>クイック操作</h2></div><button className="quick-action" onClick={()=>openPage('attendance')}><ClipboardCheck size={20}/><span><strong>出欠を入力する</strong><small>選手ごとに4種類から選択</small></span><ChevronRight size={18}/></button><button className="quick-action" onClick={()=>setMemberModal('new')}><Users size={20}/><span><strong>メンバーを登録</strong><small>選手を名簿に追加</small></span><ChevronRight size={18}/></button><button className="quick-action" onClick={()=>openPage('reports')}><CalendarDays size={20}/><span><strong>出欠履歴を照会</strong><small>日別・個別で確認</small></span><ChevronRight size={18}/></button></section></div>
        </>}
        {page==='attendance' && <>
          <div className="page-heading"><div><div className="eyebrow">ATTENDANCE</div><h1>出欠入力</h1><p>在籍中のメンバーは初期状態で「出席」です。欠席・遅刻・公欠の選手だけ変更してください。</p></div><button className="btn primary" onClick={()=>setSessionModal(true)}><Plus size={18}/>練習日を追加</button></div>
          <div className="toolbar panel"><label className="field compact"><span>練習日を選択</span><select value={currentId} onChange={e=>setSelectedSession(e.target.value)}>{sessions.length===0 && <option value="">練習日がありません</option>}{sessions.map(s=><option key={s.id} value={s.id}>{dateLabel(s.date)}　{s.title}</option>)}</select></label>{currentSession && <button className="btn danger-ghost" onClick={()=>removeSession(currentId)}><Trash2 size={16}/>この練習日を削除</button>}</div>
          {currentSession ? <>
            <div className="summary-grid">{STATUS.map(s=><div key={s.key} className={`summary-card ${s.key}`}><span>{s.label}</span><strong>{counts[s.key]}<small>名</small></strong></div>)}<div className="summary-card unmarked"><span>未入力</span><strong>{counts.unmarked}<small>名</small></strong></div></div>
            <div className="panel"><div className="panel-head wrap"><div><h2>出欠リスト</h2><p>{dateLabel(currentSession.date)} ・ {currentSession.title}　/　登録対象 {activeMembers.length}名</p></div><div className="filters"><div className="search"><Search size={17}/><input placeholder="名前・ふりがなで検索" value={filter} onChange={e=>setFilter(e.target.value)}/></div><select value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="all">全グループ</option>{groups.map(g=><option key={g} value={g}>{g}</option>)}</select></div></div>
              <div className="attendance-table-wrap"><table className="attendance-table"><thead><tr><th className="attendance-grade-column">学年</th><th className="attendance-name-column">名前</th>{STATUS.map(s=><th key={s.key}>{s.label}</th>)}</tr></thead><tbody>{filteredMembers.filter(m=>m.active).map(m=><tr key={m.id}><td className="attendance-grade-column"><span className="attendance-grade">{gradeLabel(m.grade)}</span></td><td className="attendance-name-column"><div className="attendance-person"><small className="member-furigana">{m.furigana||'　'}</small><strong>{m.name}</strong></div></td>{STATUS.map(s=><td key={s.key}><button aria-label={`${m.name} ${s.label}`} aria-pressed={getStatus(currentId,m.id)===s.key} className={`status-btn ${s.key} ${getStatus(currentId,m.id)===s.key?'selected':''}`} onClick={()=>updateStatus(currentId,m.id,s.key)}>{getStatus(currentId,m.id)===s.key && <Check size={15}/>}<span>{s.label}</span></button></td>)}</tr>)}</tbody></table>{filteredMembers.filter(m=>m.active).length===0 && <Empty title="表示できる選手がいません" detail="メンバーを登録するか、検索条件を変更してください。"/>}</div>
            </div>
          </> : <div className="panel"><Empty title="まず練習日を登録してください" detail="「練習日を追加」から日付と練習名を設定できます。"/></div>}
        </>}
        {page==='members' && <>
          <div className="page-heading"><div><div className="eyebrow">MEMBERS</div><h1>メンバー管理</h1><p>選手の登録・編集・在籍／卒団を管理します。卒団後も過去の記録は残ります。</p></div><div className="member-year-actions"><button className="btn outline" type="button" onClick={advanceSchoolYear}><CalendarDays size={18}/>新年度へ更新</button><button className="btn primary" onClick={()=>setMemberModal('new')}><Plus size={18}/>メンバーを追加</button></div></div>
          <div className="panel"><div className="panel-head wrap"><div><h2>登録メンバー <span className="heading-count">{members.length}名</span></h2><p>在籍 {activeMembers.length}名 ・ 卒団 {members.length-activeMembers.length}名</p></div><div className="filters"><div className="search"><Search size={17}/><input placeholder="名前・背番号で検索" value={filter} onChange={e=>setFilter(e.target.value)}/></div><select value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="all">全グループ</option>{groups.map(g=><option key={g} value={g}>{g}</option>)}</select></div></div>
            <div className="member-list-scroll"><table className="member-list-table"><thead><tr><th>背番号</th><th>名前</th><th>ふりがな</th><th>学年</th><th>グループ</th><th>出身校</th><th>性別</th><th>在籍状況</th><th>編集</th></tr></thead><tbody>{filteredMembers.map(m=><tr key={m.id} className="member-list-row" onClick={()=>setMemberModal(m)}><td><span className="number-tag">{m.number||'—'}</span></td><td><strong>{m.name}</strong></td><td>{m.furigana||'—'}</td><td>{m.active?(m.grade||'—'):'-'}</td><td>{m.group||'—'}</td><td>{m.active?(m.school||'—'):'-'}</td><td>{m.gender||'—'}</td><td><span className={`state-pill ${m.active?'on':'off'}`}>{m.active?'在籍中':'卒団'}</span></td><td><button type="button" className="btn outline member-edit-btn" onClick={e=>{e.stopPropagation();setMemberModal(m)}}>編集 <ChevronRight size={14}/></button></td></tr>)}</tbody></table></div>{filteredMembers.length===0 && <Empty title="メンバーが見つかりません" detail="新しいメンバーを登録してください。"/>}</div>
        </>}
        {page==='reports' && <>
          <div className="page-heading"><div><div className="eyebrow">REPORTS</div><h1>出欠照会</h1><p>日別の出欠一覧と、選手個人の出欠履歴を確認できます。</p></div><button className="btn outline" onClick={exportCsv}><ArrowDownToLine size={18}/>CSV出力</button></div>
          <div className="tabs"><button className={reportTab==='day'?'active':''} onClick={()=>setReportTab('day')}><CalendarDays size={17}/>日別照会</button><button className={reportTab==='person'?'active':''} onClick={()=>setReportTab('person')}><Users size={17}/>個別照会</button></div>
          {reportTab==='day' ? <div className="panel"><div className="panel-head wrap"><div><h2>日別出欠一覧</h2><p>練習日ごとの記録を表示します</p></div><label className="field compact"><span>練習日</span><select value={currentId} onChange={e=>setSelectedSession(e.target.value)}>{sessions.length===0 && <option value="">練習日なし</option>}{sessions.map(s=><option key={s.id} value={s.id}>{dateLabel(s.date)}　{s.title}</option>)}</select></label></div>
            {currentSession ? <><div className="report-stats">{STATUS.map(s=><span key={s.key} className={`report-stat ${s.key}`}>{s.label} <b>{counts[s.key]}</b></span>)}<span className="report-stat unmarked">未入力 <b>{counts.unmarked}</b></span></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>学年・名前（ふりがな）</th><th>グループ</th><th>出欠</th></tr></thead><tbody>{members.filter(m=>data.entries.some(e=>e.sessionId===currentId&&e.memberId===m.id)||m.active).map(m=>{const st=getStatus(currentId,m.id);const entry=data.entries.find(e=>e.sessionId===currentId&&e.memberId===m.id);return <tr key={m.id}><td><GradeName grade={historicalGrade(entry?.gradeAtTime,m,currentSession.date)} member={m}/></td><td>{m.group||'—'}</td><td><span className={`result-badge ${st||'unmarked'}`}>{STATUS.find(s=>s.key===st)?.label||'未入力'}</span></td></tr>})}</tbody></table></div></> : <Empty title="練習日の登録がありません" detail="出欠入力画面から練習日を追加してください。"/>}
          </div> : <div className="panel">
            {!personDetailOpen ? <>
              <div className="panel-head wrap"><div><h2>選手別出欠一覧</h2><p>学年・メンバー名・出席率を一覧表示します。詳細から出欠履歴を確認できます。</p></div><div className="filters"><div className="search"><Search size={17}/><input aria-label="メンバー検索" placeholder="名前・ふりがなで検索" value={filter} onChange={e=>setFilter(e.target.value)}/></div><select aria-label="グループ絞り込み" value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="all">全グループ</option>{groups.map(g=><option key={g} value={g}>{g}</option>)}</select></div></div>
              {members.length ? <div className="report-table-wrap"><table className="report-table person-list-table"><thead><tr><th>学年・名前（ふりがな）</th><th>出席率</th><th>詳細</th></tr></thead><tbody>{members.filter(m=>(groupFilter==='all'||m.group===groupFilter)&&`${m.name} ${m.furigana} ${m.group}`.toLowerCase().includes(filter.toLowerCase())).map(m=><tr key={m.id} className="person-clickable" onClick={()=>{setSelectedMember(m.id);setPersonDetailOpen(true)}}><td><GradeName grade={historicalGrade(data.entries.find(e=>e.sessionId===sessions.find(s=>data.entries.some(x=>x.sessionId===s.id&&x.memberId===m.id))?.id&&e.memberId===m.id)?.gradeAtTime,m,sessions.find(s=>data.entries.some(e=>e.sessionId===s.id&&e.memberId===m.id))?.date||today())} member={m}/></td><td><strong className="person-list-rate">{formatAttendanceRate(m,sessions,getStatus)}</strong></td><td><button className="btn outline person-detail-button" onClick={e=>{e.stopPropagation();setSelectedMember(m.id);setPersonDetailOpen(true)}}>詳細 <ChevronRight size={15}/></button></td></tr>)}</tbody></table></div> : <Empty title="メンバーが登録されていません" detail="メンバー管理から登録してください。"/>}
            </> : <>
              <div className="panel-head wrap"><div><h2>選手別出欠履歴</h2><p>個人の記録・出席率を確認できます</p></div><button className="btn outline" onClick={()=>setPersonDetailOpen(false)}>一覧へ戻る</button></div>
              {currentMemberId ? <PersonReport member={members.find(m=>m.id===currentMemberId)!} sessions={sessions} getStatus={getStatus} entries={data.entries}/> : <Empty title="メンバーが登録されていません" detail="メンバー管理から登録してください。"/>}
            </>}
          </div>}
        </>}
        {page==='times' && <>
          <div className="page-heading"><div><div className="eyebrow">RUN TIMER</div><h1>タイム入力</h1><p>欠席・公欠のメンバーは表示されません。分・秒を別々の数字入力欄に入力してください（秒は整数）。</p></div></div>
          <section className="panel run-panel"><div className="run-toolbar run-toolbar-compact"><label className="field"><span>練習日</span><select value={runSessionId} onChange={e=>setTimeSession(e.target.value)}>{sessions.map(s=><option key={s.id} value={s.id}>{dateLabel(s.date)} {s.title}</option>)}</select></label><label className="field"><span>標準の体育館</span><select value={runGymId} onChange={e=>setTimeGym(e.target.value)}><option value="">体育館を選択</option>{gyms.map(g=><option key={g.id} value={g.id}>{g.name}（1周 {g.meters}m）</option>)}</select></label><label className="field"><span>周数</span><input type="number" min="1" max="10000" value={timeLaps} onChange={e=>setTimeLaps(Number(e.target.value)||1)}/></label></div>
          {!gyms.length && <p className="run-hint">先に「データ管理」で体育館と1周の距離を登録してください。</p>}
          {!sessions.length ? <Empty title="練習日がありません" detail="出欠入力から練習日を作成してください。"/> : <div className="report-table-wrap"><table className="report-table run-table"><thead><tr><th>学年</th><th>メンバー</th><th>体育館（個別変更可）</th><th>周数</th><th>タイム</th><th>リタイア</th><th>距離</th></tr></thead><tbody>{runEligible.map(m=>{const r=runFor(runSessionId,m.id);const gym=gyms.find(g=>g.id===(r?.gymId||runGymId));return <tr key={m.id}><td className="run-grade">{gradeLabel(m.grade)}</td><td><div className="run-person"><small className="member-furigana">{m.furigana||'　'}</small><strong>{m.name}</strong></div></td><td><select aria-label={`${m.name}の体育館`} value={r?.gymId||runGymId} onChange={e=>saveRun(runSessionId,m.id,{gymId:e.target.value})}><option value="">未設定</option>{gyms.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></td><td><input aria-label={`${m.name}の周数`} type="number" min="1" max="10000" value={r?.laps??timeLaps} onChange={e=>saveRun(runSessionId,m.id,{laps:Math.max(1,Number(e.target.value)||1)})}/></td><td><RunTimeInputs key={`${runSessionId}:${m.id}`} memberName={m.name} seconds={r?.seconds??null} retired={!!r?.retired} onSave={seconds=>saveRun(runSessionId,m.id,{seconds,retired:false})}/></td><td><button className={`btn ${r?.retired?'danger':'outline'}`} onClick={()=>saveRun(runSessionId,m.id,{retired:!r?.retired,seconds:null})}>{r?.retired?'リタイア中':'リタイア'}</button></td><td>{r?.retired?'—':gym?`${((r?.laps??timeLaps)*gym.meters/1000).toFixed(2)} km`:'—'}</td></tr>})}</tbody></table>{runEligible.length===0&&<Empty title="入力対象のメンバーがいません" detail="欠席・公欠を除いた対象者が表示されます。"/>}</div>}
          </section>
        </>}
        {page==='timeReports' && <>
          <div className="page-heading"><div><div className="eyebrow">RUN RECORDS</div><h1>タイム照会</h1><p>個別・日別・歴代の記録を確認できます。距離は記録時の体育館の周長×周数で計算します。</p></div></div>
          <div className="tab-buttons">{([['person','個別'],['day','日別'],['all','歴代']] as const).map(([id,label])=><button key={id} className={`btn ${timeTab===id?'primary':'outline'}`} onClick={()=>{setTimeTab(id);if(id==='person')setPersonDetailOpen(false)}}>{label}</button>)}</div>
          <section className="panel run-panel">{timeTab==='person' && <>{!personDetailOpen ? <><div className="run-person-summary"><strong>個別タイム一覧</strong><span>メンバーを選択すると記録の詳細を確認できます。</span></div><div className="report-table-wrap"><table className="report-table run-person-list"><thead><tr><th>学年・メンバー</th><th>累計走行距離</th><th>記録件数</th><th>詳細</th></tr></thead><tbody>{activeMembers.map(m=>{const memberRuns=runs.filter(r=>r.memberId===m.id);return <tr key={m.id}><td><GradeName grade={gradeLabel(m.grade)} member={m}/></td><td className="run-distance">{distanceSum(memberRuns,gyms).toFixed(2)} km</td><td>{memberRuns.length} 件</td><td><button className="btn outline" onClick={()=>{setTimeMember(m.id);setPersonDetailOpen(true)}}>詳細 <ChevronRight size={16}/></button></td></tr>})}</tbody></table>{activeMembers.length===0&&<Empty title="在籍中のメンバーがいません" detail="メンバー管理で在籍状況を確認してください。"/>}</div></> : <><div className="run-detail-heading"><button className="btn outline" onClick={()=>setPersonDetailOpen(false)}>一覧に戻る</button><GradeName grade={gradeLabel(members.find(m=>m.id===runMemberId)?.grade||'')} member={members.find(m=>m.id===runMemberId)}/></div><div className="run-summary"><strong>累計走行距離：{distanceSum(runs.filter(r=>r.memberId===runMemberId),gyms).toFixed(2)} km</strong><span>記録 {runs.filter(r=>r.memberId===runMemberId).length} 件（リタイアを含む）</span></div><RunTable records={runs.filter(r=>r.memberId===runMemberId)} members={members} sessions={sessions} gyms={gyms}/></>}</>}
          {timeTab==='day' && <><div className="run-toolbar"><label className="field"><span>練習日</span><select value={runSessionId} onChange={e=>setTimeSession(e.target.value)}>{sessions.map(s=><option key={s.id} value={s.id}>{dateLabel(s.date)} {s.title}</option>)}</select></label></div><RunTable records={runs.filter(r=>r.sessionId===runSessionId)} members={members} sessions={sessions} gyms={gyms}/></>}
          {timeTab==='all' && <><p className="run-hint">歴代記録は体育館・周数ごとに比較してください。距離の異なるタイムを同じランキングとして比較しないため、下の条件で絞り込みます。</p><div className="run-toolbar"><label className="field"><span>体育館</span><select value={runGymId} onChange={e=>setTimeGym(e.target.value)}>{gyms.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label className="field"><span>周数</span><input type="number" min="1" value={timeLaps} onChange={e=>setTimeLaps(Math.max(1,Number(e.target.value)||1))}/></label></div><RunTable records={runs.filter(r=>r.gymId===runGymId&&r.laps===timeLaps&&r.seconds!==null&&!r.retired).sort((a,b)=>(a.seconds??Infinity)-(b.seconds??Infinity))} members={members} sessions={sessions} gyms={gyms} ranking/></>}
          </section>
        </>}
        {page==='settings' && <><div className="page-heading"><div><div className="eyebrow">DATA MANAGEMENT</div><h1>データ管理</h1><p>メンバー管理、体育館設定、バックアップ・データ移行を行います。</p></div><button className="btn primary" onClick={()=>openPage('members')}><Users size={18}/>メンバー管理</button></div><section className="panel run-panel" style={{marginBottom:20}}><div className="panel-head"><div><h2>体育館・1周の距離設定</h2><p>体育館ごとに周長（メートル）を設定します。過去の記録の距離計算にも使用されます。</p></div><button className="btn primary" onClick={()=>{const name=prompt('体育館名を入力してください');if(!name?.trim())return;const meters=Number(prompt('1周の距離（メートル）','100'));if(!Number.isFinite(meters)||meters<=0){alert('距離は0より大きい数値にしてください');return}setData(d=>({...d,gyms:[...(d.gyms||[]),{id:uid(),name:name.trim(),meters}]}))}}><Plus size={16}/>体育館を追加</button></div><div className="gym-list">{gyms.map(g=><div key={g.id} className="gym-row"><strong>{g.name}</strong><span>1周 {g.meters} m</span><button className="btn outline" onClick={()=>{const name=prompt('体育館名',g.name);if(!name?.trim())return;const meters=Number(prompt('1周の距離（メートル）',String(g.meters)));if(!Number.isFinite(meters)||meters<=0)return;setData(d=>({...d,gyms:(d.gyms||[]).map(x=>x.id===g.id?{...x,name:name.trim(),meters}:x)}))}}>編集</button><button className="btn danger-ghost" onClick={()=>{if(runs.some(r=>r.gymId===g.id)){alert('この体育館を使用したタイム記録があります。削除できません');return}if(confirm('体育館を削除しますか？'))setData(d=>({...d,gyms:(d.gyms||[]).filter(x=>x.id!==g.id)}))}}>削除</button></div>)}{!gyms.length&&<p>体育館はまだ登録されていません。</p>}</div></section><section className="panel" style={{padding:24,marginBottom:20}}><div className="panel-head"><div><h2>Access（Excel）データを取り込む</h2><p>M_選手.xlsx・T_実績.xlsx に対応。既存データは残し、未登録のメンバー・練習日・出欠を追加します。</p></div></div>
  <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:16}}>
    <label className="field" style={{flex:'1 1 250px'}}><span>メンバーマスタ（M_選手.xlsx）</span><input ref={masterRef} type="file" accept=".xlsx,.xls" onChange={e=>{setMasterFile(e.target.files?.[0]);setAccessPreview(null)}}/></label>
    <label className="field" style={{flex:'1 1 250px'}}><span>出欠履歴（T_実績.xlsx）</span><input ref={historyRef} type="file" accept=".xlsx,.xls" onChange={e=>{setHistoryFile(e.target.files?.[0]);setAccessPreview(null)}}/></label>
  </div>
  <p className="form-help">どちらか一方でも取り込めます。まず「内容を確認」で差分を確認してください。同じ日付・練習名を同じ練習として扱い、既存の出欠は上書きしません。名前とグループ（ふりがながあれば照合）でメンバーを照合します。</p>
  <button className="btn outline" disabled={accessBusy||(!masterFile&&!historyFile)} onClick={()=>void previewAccess()}><FileUp size={18}/>{accessBusy?'読み込み中…':'内容を確認'}</button>
  {accessPreview && <div style={{marginTop:18,padding:16,background:'#f5f8ff',borderRadius:10}}>
    <strong>取り込み内容の確認</strong>
    <p>読み込み行数: {accessPreview.sourceRows}行 ／ 新規メンバー: {accessPreview.addedMembers}人 ／ 既存メンバーへの情報補完: {accessPreview.updatedMembers}件 ／ 新規練習日: {accessPreview.addedSessions}件 ／ 新規出欠: {accessPreview.addedEntries}件 ／ スキップ: {accessPreview.skippedEntries}件</p>
    {accessPreview.warnings.length>0 && <details><summary>注意・スキップ内容（{accessPreview.warnings.length}件）</summary><div style={{maxHeight:180,overflowY:'auto'}}>{accessPreview.warnings.slice(0,100).map((w,i)=><p key={i} style={{fontSize:12}}>{w}</p>)}{accessPreview.warnings.length>100&&<p>残り{accessPreview.warnings.length-100}件は省略</p>}</div></details>}
    <button className="btn primary" style={{marginTop:12}} onClick={applyAccess}>確認して差分を取り込む</button>
  </div>}
</section><div className="settings-grid"><section className="panel settings-card"><div className="settings-icon"><Download size={24}/></div><h2>全データをバックアップ</h2><p>メンバー、練習日、出欠記録を1つのJSONファイルとして保存します。</p><button className="btn primary" onClick={exportBackup}><Download size={18}/>バックアップを保存</button></section><section className="panel settings-card"><div className="settings-icon"><FileUp size={24}/></div><h2>バックアップから復元</h2><p>保存済みのJSONファイルから復元します。現在のデータはすべて置き換わります。</p><input ref={importRef} type="file" accept=".json,application/json" hidden onChange={e=>void importBackup(e.target.files?.[0])}/><button className="btn outline" onClick={()=>importRef.current?.click()}><FileUp size={18}/>ファイルを選択</button></section><section className="panel settings-card"><div className="settings-icon"><ArrowDownToLine size={24}/></div><h2>CSVで書き出し</h2><p>全練習日・全メンバーの出欠記録を表計算ソフトで開けるCSV形式で出力します。</p><button className="btn outline" onClick={exportCsv}><ArrowDownToLine size={18}/>CSVを保存</button></section></div><div className="info-note"><ShieldCheck size={19}/><span>このバージョンはオフライン・端末内保存です。別端末との自動同期はありません。ブラウザのデータ削除や端末故障に備え、JSONバックアップを別の場所に保管してください。</span></div></>}
      </main>
    </div>
    <nav className="mobile-nav">{navigation.map(n=><button key={n.key} className={(page===n.key||(page==='members'&&n.key==='settings'))?'active':''} onClick={()=>openPage(n.key)}><n.icon size={20}/><span>{n.label}</span></button>)}</nav>
    {memberModal && <MemberModal value={memberModal} groups={groups} onClose={()=>setMemberModal(null)} onSave={m=>{setData(d=>({...d,members:memberModal==='new'?[...d.members,m]:d.members.map(x=>x.id===m.id?m:x)}));setMemberModal(null);setNotice('メンバーを保存しました')}} onDelete={m=>{if(!confirm(`${m.name}を削除しますか？過去の出欠記録も削除されます。`))return;setData(d=>({...d,members:d.members.filter(x=>x.id!==m.id),entries:d.entries.filter(e=>e.memberId!==m.id),runs:(d.runs||[]).filter(r=>r.memberId!==m.id)}));setMemberModal(null);setNotice('メンバーを削除しました')}}/>}
    {sessionModal && <SessionModal onClose={()=>setSessionModal(false)} onSave={(date,title)=>{const s:Session={id:uid(),date,title,createdAt:new Date().toISOString()};setData(d=>({...d,sessions:[...d.sessions,s],entries:[...d.entries,...d.members.filter(m=>m.active).map(m=>({sessionId:s.id,memberId:m.id,status:'present' as Status,gradeAtTime:gradeLabel(m.grade)}))]}));setSelectedSession(s.id);setSessionModal(false);setPage('attendance');setNotice('練習日を追加しました')}}/>}
    {notice && <div className="toast"><Check size={18}/>{notice}</div>}
  </div>
}
function Metric({label,value,suffix,icon,tone}:{label:string;value:number;suffix:string;icon:React.ReactNode;tone:string}){return <div className="metric"><div className={`metric-icon ${tone}`}>{icon}</div><span>{label}</span><strong>{value}<small>{suffix}</small></strong></div>}
function Empty({title,detail}:{title:string;detail:string}){return <div className="empty"><div className="empty-icon"><ClipboardCheck size={28}/></div><strong>{title}</strong><p>{detail}</p></div>}
function MemberModal({value,groups,onClose,onSave,onDelete}:{value:Member|'new';groups:string[];onClose:()=>void;onSave:(m:Member)=>void;onDelete:(m:Member)=>void}){
 const existing = value==='new'?null:value
 const [name,setName]=useState(existing?.name||'')
 const [furigana,setFurigana]=useState(existing?.furigana||'')
 const [number,setNumber]=useState(existing?.number||'')
 const [grade,setGrade]=useState(existing?.active===false?'':existing?.grade||'')
 const [group,setGroup]=useState(existing?.group||'')
 const [school,setSchool]=useState(existing?.active===false?'':existing?.school||'')
 const [gender,setGender]=useState(existing?.gender||'')
 const [active,setActive]=useState(existing?.active??true)
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal"><div className="modal-head"><h2>{existing?'メンバーを編集':'メンバーを追加'}</h2><button className="icon-btn" onClick={onClose} aria-label="閉じる"><X size={20}/></button></div><form onSubmit={e=>{e.preventDefault();if(!name.trim())return;onSave({id:existing?.id||uid(),name:name.trim(),furigana:furigana.trim(),number:number.trim(),grade:active?grade:'',group:group.trim(),school:active?school.trim():'',gender,active,createdAt:existing?.createdAt||new Date().toISOString()})}}><div className="modal-body">
 <label className="field"><span>名前 <em>必須</em></span><input autoFocus required maxLength={60} placeholder="例：山田 太郎" value={name} onChange={e=>setName(e.target.value)}/></label>
 <label className="field"><span>ふりがな</span><input maxLength={80} placeholder="例：やまだ たろう" value={furigana} onChange={e=>setFurigana(e.target.value)}/></label>
 <label className="field"><span>背番号</span><input maxLength={8} placeholder="例：12" value={number} onChange={e=>setNumber(e.target.value)}/></label>
 <label className="field"><span>学年</span><select disabled={!active} value={active?grade:''} onChange={e=>setGrade(e.target.value)}><option value="">未設定</option>{['小学1年','小学2年','小学3年','小学4年','小学5年','小学6年','中学1年','中学2年','中学3年','高校1年','高校2年','高校3年','その他'].map(g=><option key={g} value={g}>{g}</option>)}</select></label>
 <label className="field"><span>グループ</span><input maxLength={40} list="group-options" placeholder="例：男子、女子、U12" value={group} onChange={e=>setGroup(e.target.value)}/><datalist id="group-options">{groups.map(g=><option key={g} value={g}/>)}</datalist></label>
 <label className="field"><span>出身校</span><input disabled={!active} maxLength={80} placeholder="例：○○小学校" value={school} onChange={e=>setSchool(e.target.value)}/></label>
 <label className="field"><span>性別</span><select value={gender} onChange={e=>setGender(e.target.value)}><option value="">未設定</option><option value="男">男</option><option value="女">女</option><option value="その他">その他</option></select></label>
 <label className="field"><span>在籍状況</span><select value={active ? "active" : "graduated"} onChange={e=>setActive(e.target.value === "active")}><option value="active">在籍中</option><option value="graduated">卒団</option></select><small className="form-help">卒団にすると今後の出欠入力対象から外れます。メンバー情報と過去の出欠履歴は保存され、個別照会でも確認できます。</small></label></div><div className="modal-actions">{existing&&<button type="button" className="btn danger-ghost" onClick={()=>onDelete(existing)}><Trash2 size={16}/>削除</button>}<div className="push"/><button type="button" className="btn outline" onClick={onClose}>キャンセル</button><button type="submit" className="btn primary">保存する</button></div></form></div></div>
}
function SessionModal({onClose,onSave}:{onClose:()=>void;onSave:(date:string,title:string)=>void}){const [date,setDate]=useState(today());const [title,setTitle]=useState('通常練習');return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal"><div className="modal-head"><h2>練習日を追加</h2><button className="icon-btn" onClick={onClose} aria-label="閉じる"><X size={20}/></button></div><form onSubmit={e=>{e.preventDefault();if(date&&title.trim())onSave(date,title.trim())}}><div className="modal-body"><label className="field"><span>日付 <em>必須</em></span><input type="date" required value={date} onChange={e=>setDate(e.target.value)}/></label><label className="field"><span>練習名 <em>必須</em></span><input required maxLength={80} placeholder="例：通常練習、練習試合" value={title} onChange={e=>setTitle(e.target.value)}/></label><p className="form-help">同じ日に複数の練習日を登録することもできます。</p></div><div className="modal-actions"><button type="button" className="btn outline" onClick={onClose}>キャンセル</button><button type="submit" className="btn primary">追加して出欠入力</button></div></form></div></div>}
function formatAttendanceRate(member: Member, sessions: Session[], getStatus: (s:string,m:string)=>Status|undefined): string {
 let present=0, late=0, absent=0
 for (const s of sessions) { const status=getStatus(s.id,member.id); if(status==='present')present++; else if(status==='late')late++; else if(status==='absent')absent++ }
 const total=present+late+absent
 return total ? `${Math.round((present+late)/total*100)}%` : '—'
}
function PersonReport({member,sessions,getStatus,entries}:{member:Member;sessions:Session[];getStatus:(s:string,m:string)=>Status|undefined;entries:Entry[]}){const counts={present:0,absent:0,late:0,excused:0,unmarked:0};for(const s of sessions){const status=getStatus(s.id,member.id);if(status)counts[status]++;else counts.unmarked++}const denominator=counts.present+counts.absent+counts.late;const rate=denominator?Math.round((counts.present+counts.late)/denominator*100):null;return <><div className="person-overview"><div className="person-heading"><div><small>{member.furigana}</small><h3>{member.name}</h3><p>{member.group||'グループ未設定'}</p></div></div><div className="rate"><small>出席率（出席＋遅刻 / 公欠・未入力を除く）</small><strong>{rate===null?'—':`${rate}%`}</strong></div></div><div className="report-stats">{STATUS.map(s=><span key={s.key} className={`report-stat ${s.key}`}>{s.label} <b>{counts[s.key]}</b></span>)}<span className="report-stat unmarked">未入力 <b>{counts.unmarked}</b></span></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>日付</th><th>学年・名前</th><th>練習名</th><th>出欠</th></tr></thead><tbody>{sessions.map(s=>{const st=getStatus(s.id,member.id);return <tr key={s.id}><td>{dateLabel(s.date)}</td><td><GradeName grade={historicalGrade(entries.find(e=>e.sessionId===s.id&&e.memberId===member.id)?.gradeAtTime,member,s.date)} member={member}/></td><td>{s.title}</td><td><span className={`result-badge ${st||'unmarked'}`}>{STATUS.find(x=>x.key===st)?.label||'未入力'}</span></td></tr>})}</tbody></table>{sessions.length===0&&<Empty title="出欠記録がありません" detail="練習日を登録してください。"/>}</div></>}

function getRunAttendance(entries:Entry[],sid:string,mid:string):Status|undefined {return entries.find(e=>e.sessionId===sid&&e.memberId===mid)?.status}
function formatTime(s:number):string {const totalSeconds=Math.round(s);return `${Math.floor(totalSeconds/60)}:${String(totalSeconds%60).padStart(2,'0')}`}
function distanceSum(records:RunRecord[],gyms:Gym[]):number{return records.reduce((sum,r)=>sum+(r.retired?0:(gyms.find(g=>g.id===r.gymId)?.meters||0)*r.laps/1000),0)}
function gradeLabel(grade:string):string {const value=grade.trim().replace(/^小学/, '');if(!value)return '—';if(/年$/.test(value))return value;if(/^\d+$/.test(value))return `${value}年`;return value}
function RunTimeInputs({memberName,seconds,retired,onSave}:{memberName:string;seconds:number|null;retired:boolean;onSave:(seconds:number|null)=>void}) {
  const [minutes,setMinutes] = useState(seconds===null?'':String(Math.floor(Math.round(seconds)/60)))
  const [remaining,setRemaining] = useState(seconds===null?'':String(Math.round(seconds)%60).padStart(2,'0'))
  const commit = () => {
    if (retired) return
    const m=minutes.trim(), sec=remaining.trim()
    if (!m && !sec) { if(seconds!==null) onSave(null); return }
    const minuteNumber=Number(m||'0'), secondNumber=Number(sec||'0')
    if (!Number.isInteger(minuteNumber)||minuteNumber<0||!Number.isFinite(secondNumber)||secondNumber<0||secondNumber>=60||!/^\d*$/.test(m)||!/^\d*(?:\.\d{0,2})?$/.test(sec)) {
      alert('分は0以上の整数、秒は0〜59の整数で入力してください')
      setMinutes(seconds===null?'':String(Math.floor(Math.round(seconds)/60)))
      setRemaining(seconds===null?'':String(Math.round(seconds)%60).padStart(2,'0'))
      return
    }
    const next=minuteNumber*60+secondNumber
    setMinutes(String(minuteNumber))
    setRemaining(String(secondNumber).padStart(2,'0'))
    if (next!==seconds) onSave(next)
  }
  return <div className="run-time-parts">
    <label><input aria-label={`${memberName}の分`} inputMode="numeric" type="number" min="0" step="1" placeholder="0" value={minutes} disabled={retired} onChange={e=>setMinutes(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/><span>分</span></label>
    <label><input aria-label={`${memberName}の秒`} inputMode="numeric" type="text" placeholder="00" value={remaining} disabled={retired} onChange={e=>setRemaining(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/><span>秒</span></label>
  </div>
}

function RunTable({records,members,sessions,gyms,ranking=false}:{records:RunRecord[];members:Member[];sessions:Session[];gyms:Gym[];ranking?:boolean}) {return <div className="report-table-wrap"><table className="report-table"><thead><tr>{ranking&&<th>順位</th>}<th>日付</th><th>学年・名前</th><th>体育館</th><th>周数</th><th>距離</th><th>タイム</th></tr></thead><tbody>{records.map((r,i)=>{const m=members.find(x=>x.id===r.memberId);const s=sessions.find(x=>x.id===r.sessionId);const g=gyms.find(x=>x.id===r.gymId);return <tr key={`${r.sessionId}:${r.memberId}`}>{ranking&&<td>{i+1}</td>}<td>{dateLabel(s?.date||'')}</td><td><GradeName grade={historicalGrade(r.gradeAtTime,m,s?.date||'')} member={m}/></td><td>{g?.name||'未設定'}</td><td>{r.laps}</td><td>{r.retired?'—':g?`${(r.laps*g.meters/1000).toFixed(2)} km`:'—'}</td><td>{r.retired?'リタイア':r.seconds!==null?formatTime(r.seconds):'未入力'}</td></tr>})}</tbody></table>{records.length===0&&<Empty title="タイム記録がありません" detail="タイム入力画面で記録してください。"/>}</div>}
