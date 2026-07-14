interface EmptyStateProps {
  title: string;
  detail?: string;
}

export function EmptyState({ title, detail }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}
