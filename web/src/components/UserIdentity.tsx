interface Props {
  userName: string
  onChange: (name: string) => void
}

export default function UserIdentity({ userName, onChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-400 whitespace-nowrap">
        Display name:
      </label>
      <input
        type="text"
        value={userName}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter your name"
        className="border border-gray-300 rounded px-2 py-1 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
    </div>
  )
}
