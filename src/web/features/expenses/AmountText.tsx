// A formatted money string (from useT().money) printed the receipt way: the currency prefix in
// a .cur span and every comma and point in a .sep span (pulled in, see global.css .amt), so
// ¥1,712,140 reads as one number. The parent element carries the .amt class.

/** Any text with every comma and point in a .sep span (an expression like "8,400 + 4,200"). */
export function SepText({ text }: { text: string }) {
  const parts = text.split(/([.,])/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="sep">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

export function AmountText({ text }: { text: string }) {
  const m = /^([+-]?)(\D*?)(\d[\d.,]*)(.*)$/.exec(text);
  if (!m) return <>{text}</>;
  const [, sign, prefix, num, rest] = m;
  const parts = num.split(/([.,])/);
  return (
    <>
      {sign}
      {prefix ? <span className="cur">{prefix}</span> : null}
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="sep">
            {p}
          </span>
        ) : (
          p
        ),
      )}
      {rest}
    </>
  );
}
