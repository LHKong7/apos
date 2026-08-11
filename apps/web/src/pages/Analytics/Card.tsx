export function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
      <h3 className="text-xs font-semibold tracking-tight text-slate-700">{title}</h3>
      {subtitle && <p className="mb-2 mt-0.5 text-[11px] text-slate-400">{subtitle}</p>}
      {children}
    </section>
  );
}
