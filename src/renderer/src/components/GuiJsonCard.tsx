export default function GuiJsonCard({ formatted }: { formatted: string }): React.JSX.Element {
  return (
    <pre className="gui-json-card" aria-label="JSON formatado">
      <code>{formatted}</code>
    </pre>
  )
}
