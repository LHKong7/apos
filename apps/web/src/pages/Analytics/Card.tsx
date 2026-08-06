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
    <section className="rounded border border-slate-200 bg-white px-3 py-2">
      <h3 className="text-xs font-medium text-slate-700">{title}</h3>
      {subtitle && <p className="mb-1.5 text-[11px] text-slate-400">{subtitle}</p>}
      {children}
    </section>
  );
}
