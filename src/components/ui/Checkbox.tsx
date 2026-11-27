import { type InputHTMLAttributes } from 'react'

/**
 * The app's checkbox: a real, restyled native checkbox (keyboard, screen readers and
 * tests see the native control) whose tick draws itself in (motion.css .todo-check).
 */
export function Checkbox({ className = '', ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className={`todo-check ${className}`}>
      <input type="checkbox" className="todo-check__input" {...rest} />
      <svg className="todo-check__mark" viewBox="0 0 18 18" aria-hidden="true"><path d="M4.75 9.4l2.9 2.85L13.4 6.3" /></svg>
    </span>
  )
}
