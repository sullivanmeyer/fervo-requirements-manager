/**
 * TagInput
 *
 * A chip-style text input for free-form tags.
 * Press Enter or comma to add a tag; click × on a chip to remove it.
 */
import { useState } from 'react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
}

export default function TagInput({ tags, onChange }: Props) {
  const [input, setInput] = useState('')

  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/,+$/, '')
    if (tag && !tags.includes(tag)) {
      onChange([...tags, tag])
    }
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
      // Remove last tag when backspacing on empty input
      onChange(tags.slice(0, -1))
    }
  }

  const handleBlur = () => {
    if (input.trim()) addTag(input)
  }

  return (
    <div className="flex flex-wrap gap-1.5 border border-gray-300 rounded px-2 py-1.5 min-h-9 focus-within:ring-1 focus-within:ring-blue-400 focus-within:border-blue-400 bg-white cursor-text">
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded border border-gray-200"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="text-gray-400 hover:text-gray-700 leading-none"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={tags.length === 0 ? 'Add tags (Enter or comma to confirm)' : ''}
        className="flex-1 min-w-24 text-sm outline-none bg-transparent py-0.5"
      />
    </div>
  )
}
