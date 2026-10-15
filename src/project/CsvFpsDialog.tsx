import { useEffect, useRef, useState } from 'react'
import { useImportUi } from '../importActions'

/** Always mounted (App): asks the fps of headerless CSVs when importCsvFiles needs it. */
export default function CsvFpsDialog() {
  const ask = useImportUi(s => s.ask)
  const dlg = useRef<HTMLDialogElement>(null)
  const [fps, setFps] = useState<30 | 50 | 60>(30)
  useEffect(() => { if (ask && !dlg.current?.open) { setFps(30); dlg.current?.showModal() } }, [ask])
  const answer = (v: 30 | 50 | 60 | null) => { useImportUi.getState().ask?.(v); useImportUi.setState({ ask: null }) }
  return (
    <dialog ref={dlg} className="pp-dlg" onKeyDown={e => e.stopPropagation()} onClose={() => answer(null)}>
      <form method="dialog" onSubmit={e => { if ((e.nativeEvent as SubmitEvent).submitter?.id === 'pp-go') answer(fps) }}>
        <p>헤더 없는 CSV의 fps</p>
        {([30, 50, 60] as const).map(v => (
          <label key={v}><input type="radio" name="fps" checked={fps === v} onChange={() => setFps(v)} />{v}fps</label>
        ))}
        <div className="pp-btns"><button id="pp-go">가져오기</button><button value="cancel" type="submit" formNoValidate>취소</button></div>
      </form>
    </dialog>
  )
}
