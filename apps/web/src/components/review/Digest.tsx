const TOKEN = /(<REDACTED:[a-z_]+>|<USER>|<PROJECT>|<ORG>)/
const IS_TOKEN = /^<(REDACTED:[a-z_]+|USER|PROJECT|ORG)>$/

/** The redacted digest exactly as it left the machine. Markers sit on a fill so every redaction is visible. */
export function Digest({ text }: { text: string }) {
  return (
    <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words border border-rule p-4 font-mono text-[12px] leading-[19px] text-text-2">
      {text.split('\n').map((line, i) => {
        const m = line.match(/^(\[[a-z]+\])\s?(.*)$/)
        const head = m?.[1]
        const rest = m ? m[2] : line
        return (
          <div key={i}>
            {head && <span className="text-text-2">{head} </span>}
            {rest.split(TOKEN).map((part, j) =>
              IS_TOKEN.test(part) ? (
                <span key={j} className="bg-fill px-1 text-text">
                  {part}
                </span>
              ) : (
                <span key={j}>{part}</span>
              ),
            )}
          </div>
        )
      })}
    </pre>
  )
}
