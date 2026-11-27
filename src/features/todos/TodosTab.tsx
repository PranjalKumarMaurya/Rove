import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { AsyncLabel, useAsyncStatus } from '../../components/ui/AsyncButton'
import { Checkbox } from '../../components/ui/Checkbox'
import { Collapse } from '../../components/ui/Collapse'
import { foldProps, useExitList } from '../../components/ui/motion'
import { Swap } from '../../components/ui/Swap'
import { LiveBadge } from '../trip/useLiveRefetch'
import type { TripTabProps } from '../workspace/tripTab'
import { memberName, splitTodos, TODO_TITLE_MAX, validateTodoTitle, type TripTodo } from './todoList'
import { addTodo, clearCompleted, deleteTodo, renameTodo, setTodoDone, useTripTodos } from './tripTodosApi'

const smallButton: CSSProperties = {
  fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 10px', flexShrink: 0,
}
/** Border and background come from `.m-input` (motion.css), so focus eases them in. */
const inputStyle: CSSProperties = {
  color: 'var(--text-primary)', borderRadius: 12, padding: '10px 14px', fontSize: 14, outline: 'none', minWidth: 0,
}

const foldGap = { '--fold-gap': '8px' } as CSSProperties

/** A rename in progress. `from` is the title the user started editing. */
interface Editing { id: string; from: string; draft: string; conflict: boolean }

export function TodosTab({ trip, roster }: TripTabProps) {
  const { todos, loading, error, live, reload, patchLocal } = useTripTodos(trip.groupId)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const { open, done } = useMemo(() => splitTodos(todos), [todos])
  // Rows the person deletes, ticks or unticks fold out of their list (and rise into the other).
  const openRows = useExitList(open, (todo) => todo.id)
  const doneRows = useExitList(done, (todo) => todo.id)
  const nameOf = (memberId: string | null) => memberName(roster, memberId, trip.groupMemberId)

  // A todo being renamed was deleted by someone else: say so instead of silently dropping the draft.
  useEffect(() => {
    if (editing && !loading && !todos.some((todo) => todo.id === editing.id)) {
      setNotice(`Another member removed “${editing.from}” while you were renaming it.`)
      setEditing(null)
    }
  }, [editing, loading, todos])

  const run = async (action: () => Promise<unknown>, message: string) => {
    setFailure(null)
    try {
      await action()
    } catch {
      setFailure(message)
    } finally {
      void reload()
    }
  }

  const toggle = (todo: TripTodo, next: boolean) => {
    ;(todo.done ? doneRows : openRows).exit(todo.id)
    patchLocal(todo.id, next
      ? { done: true, completed_by: trip.groupMemberId, completed_at: new Date().toISOString() }
      : { done: false, completed_by: null, completed_at: null })
    void run(() => setTodoDone(trip.groupId, todo.id, next), 'Could not update that todo. Try again.')
  }

  const saveRename = async (current: Editing, overwriteFrom?: string) => {
    const checked = validateTodoTitle(current.draft)
    if (!checked.ok) {
      setFailure(checked.error)
      return
    }
    if (checked.title === (overwriteFrom ?? current.from)) {
      setEditing(null)
      return
    }
    setFailure(null)
    try {
      const outcome = await renameTodo(trip.groupId, current.id, overwriteFrom ?? current.from, checked.title)
      if (outcome === 'saved') setEditing(null)
      else if (outcome === 'conflict') setEditing({ ...current, conflict: true })
      else {
        setEditing(null)
        setNotice(`Another member removed “${current.from}” while you were renaming it.`)
      }
    } catch {
      setFailure('Could not rename that todo. Try again.')
    } finally {
      void reload()
    }
  }

  const clearDone = async () => {
    if (editing && done.some((todo) => todo.id === editing.id)) setEditing(null)
    setClearing(true)
    for (const todo of done) doneRows.exit(todo.id)
    await run(() => clearCompleted(trip.groupId, done.map((todo) => todo.id)), 'Could not clear completed todos. Try again.')
    setClearing(false)
  }

  // A row folding out of one list keeps its old snapshot; draw it from the latest
  // copy so the box you just ticked shows ticked while it folds away.
  const latest = new Map(todos.map((item) => [item.id, item]))
  const rowProps = (snapshot: TripTodo) => {
    const todo = latest.get(snapshot.id) ?? snapshot
    return ({
    todo,
    attribution: todo.done ? `Done by ${nameOf(todo.completed_by)}` : `Added by ${nameOf(todo.created_by)}`,
    editing: editing?.id === todo.id ? editing : null,
    onToggle: (next: boolean) => toggle(todo, next),
    onStartRename: () => { setNotice(null); setEditing({ id: todo.id, from: todo.title, draft: todo.title, conflict: false }) },
    onDraft: (draft: string) => setEditing((current) => current && current.id === todo.id ? { ...current, draft } : current),
    onSaveRename: (overwriteFrom?: string) => editing && void saveRename(editing, overwriteFrom),
    onCancelRename: () => setEditing(null),
    onDelete: () => {
      ;(todo.done ? doneRows : openRows).exit(todo.id)
      return run(() => deleteTodo(trip.groupId, todo.id), 'Could not delete that todo. Try again.')
    },
  })
  }

  return (
    <section data-testid="todos-tab" className="flex flex-col gap-6">
      <div className="surface px-4 py-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="serif-display" style={{ color: 'var(--text-primary)', fontSize: 25 }}>Todos</h2>
          <LiveBadge status={live} />
        </div>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>One shared list for everyone in this Trip.</p>
        <AddTodo onAdd={(title) => addTodo(trip.groupId, trip.groupMemberId, title).finally(() => void reload())} />
      </div>

      <Collapse open={Boolean(failure)} gap={24}>
        <p role="alert" className="surface px-3.5 py-3 text-sm" style={{ color: 'var(--accent)' }}>{failure}</p>
      </Collapse>
      <Collapse open={Boolean(notice)} gap={24}>
        <p role="status" className="surface px-3.5 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {notice} <button type="button" onClick={() => setNotice(null)} style={{ color: 'var(--accent)' }}>Dismiss</button>
        </p>
      </Collapse>
      <Collapse open={Boolean(error)} gap={24}>
        <p role="alert" className="surface px-3.5 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Could not load the list. <button type="button" onClick={() => void reload()} style={{ color: 'var(--accent)' }}>Try again</button>
        </p>
      </Collapse>

      <Swap id={loading ? 'loading' : !error && todos.length === 0 ? 'empty' : 'list'}>
      {loading ? (
        <p role="status" className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading todos…</p>
      ) : !error && todos.length === 0 ? (
        <div className="m-appear px-1" data-testid="todos-empty">
          <p className="serif-display" style={{ color: 'var(--text-secondary)', fontSize: 19 }}>Nothing on the list yet.</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>Add what the group needs to sort out before or during the Trip.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="todos-open-heading">
            <p id="todos-open-heading" className="font-mono mb-2.5" style={{ color: 'var(--accent)', fontSize: 11, letterSpacing: '0.12em' }}>TO DO — {open.length}</p>
            {open.length === 0
              ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>All done.</p>
              : <ul aria-label="Open todos" className="m-list flex flex-col gap-2" style={foldGap}>
                {openRows.entries.map(({ item, leaving }) => <TodoRow key={item.id} leaving={leaving} {...rowProps(item)} />)}
              </ul>}
          </section>
          <Collapse open={done.length > 0} gap={24}>
            <section aria-labelledby="todos-done-heading">
              <div className="mb-2.5 flex items-center justify-between">
                <p id="todos-done-heading" className="font-mono" style={{ color: 'var(--text-tertiary)', fontSize: 11, letterSpacing: '0.12em' }}>DONE — {done.length}</p>
                <button type="button" disabled={clearing} onClick={() => void clearDone()} className="text-xs underline" style={{ color: 'var(--text-tertiary)' }}>
                  {clearing ? 'Clearing…' : 'Clear completed'}
                </button>
              </div>
              <ul aria-label="Completed todos" className="m-list flex flex-col gap-2" style={foldGap}>
                {doneRows.entries.map(({ item, leaving }) => <TodoRow key={item.id} leaving={leaving} {...rowProps(item)} />)}
              </ul>
            </section>
          </Collapse>
        </div>
      )}
      </Swap>
    </section>
  )
}

/** Owns its draft so list refreshes never reset what the user is typing. */
function AddTodo({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const action = useAsyncStatus()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy.current) return
    const checked = validateTodoTitle(draft)
    if (!checked.ok) {
      setError(checked.error)
      return
    }
    busy.current = true
    setError(null)
    action.busy()
    try {
      await onAdd(checked.title)
      // Keep anything typed while the request was in flight.
      setDraft((current) => current.trim() === checked.title ? '' : current)
      busy.current = false
      // "Added ✓" for a moment; the next todo can be added meanwhile.
      void action.done().then(() => { if (!busy.current) action.reset() })
    } catch {
      setError('Could not add that. Try again.')
      busy.current = false
      action.fail()
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Add a todo" className="mt-4 flex flex-col gap-1.5">
      <div className="flex gap-2">
        {/* Never disabled while saving: disabling would drop keyboard focus. */}
        <input aria-label="New todo" value={draft} maxLength={TODO_TITLE_MAX} placeholder="Book the airport transfer…"
          onChange={(event) => { setDraft(event.target.value); if (error) setError(null) }} className="m-input flex-1" style={inputStyle} />
        <button type="submit" className="m-press rounded-xl px-4 text-sm" aria-busy={action.status === 'busy' || undefined}
          style={{ background: 'var(--accent)', color: '#1A0A03', fontWeight: 600 }}>
          <AsyncLabel status={action.status} busyLabel="Adding…" doneLabel="Added">Add todo</AsyncLabel>
        </button>
      </div>
      <Collapse open={Boolean(error)} gap={6}>
        <p role="alert" className="text-xs" style={{ color: 'var(--accent)' }}>{error}</p>
      </Collapse>
    </form>
  )
}

function TodoRow({ todo, attribution, editing, onToggle, onStartRename, onDraft, onSaveRename, onCancelRename, onDelete, leaving = false }: {
  /** Removed or moved by the person: folding away. */
  leaving?: boolean
  todo: TripTodo
  attribution: string
  editing: Editing | null
  onToggle: (done: boolean) => void
  onStartRename: () => void
  onDraft: (draft: string) => void
  onSaveRename: (overwriteFrom?: string) => void
  onCancelRename: () => void
  onDelete: () => Promise<void>
}) {
  const changedElsewhere = editing !== null && todo.title !== editing.from

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') onCancelRename()
  }

  return (
    <li data-testid="todo-row" data-done={todo.done} {...foldProps(leaving)}>
      <div><div className="surface px-3 py-2.5">
      {editing ? (
        <form onSubmit={(event) => { event.preventDefault(); onSaveRename() }} aria-label={`Rename ${editing.from}`} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input aria-label="Todo title" autoFocus value={editing.draft} maxLength={TODO_TITLE_MAX} onChange={(event) => onDraft(event.target.value)}
              onKeyDown={onKey} className="m-input flex-1" style={inputStyle} />
            <button type="submit" className="m-press" style={smallButton}>Save</button>
            <button type="button" onClick={onCancelRename} className="m-press" style={smallButton}>Cancel</button>
          </div>
          {changedElsewhere && !editing.conflict && (
            <p role="status" className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Someone else changed this to “{todo.title}”.</p>
          )}
          {editing.conflict && (
            <div role="alert" className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Not saved: someone else changed this to “{todo.title}”. Your text is kept.
              <div className="mt-1.5 flex gap-2">
                <button type="button" onClick={() => onSaveRename(todo.title)} style={smallButton}>Save mine anyway</button>
                <button type="button" onClick={onCancelRename} style={smallButton}>Keep theirs</button>
              </div>
            </div>
          )}
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            {/* Native checkbox, restyled so its tick can draw itself in (motion.css). */}
            <Checkbox checked={todo.done} onChange={(event) => onToggle(event.target.checked)} />
            <span className="todo-text min-w-0 break-words text-sm" style={{
              color: todo.done ? 'var(--text-tertiary)' : 'var(--text-primary)', textDecoration: todo.done ? 'line-through' : 'none',
            }}>{todo.title}</span>
          </label>
          <button type="button" aria-label={`Rename ${todo.title}`} onClick={onStartRename} className="m-press" style={smallButton}>Rename</button>
          <button type="button" aria-label={`Delete ${todo.title}`} onClick={() => void onDelete()} className="m-press" style={smallButton}>Delete</button>
        </div>
      )}
      {!editing && <p className="font-mono mt-1 pl-[30px]" data-testid="todo-attribution" style={{ color: 'var(--text-tertiary)', fontSize: 10, letterSpacing: '0.06em' }}>{attribution}</p>}
      </div></div>
    </li>
  )
}
