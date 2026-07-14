import { useI18n } from '../app/i18n.js';

interface TimestampProps {
  value: string;
  relative?: boolean;
}

function relativeTime(value: string, locale: string): string {
  const elapsedSeconds = Math.round((Date.parse(value) - Date.now()) / 1_000);
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = absoluteSeconds < 60
    ? [elapsedSeconds, 'second']
    : absoluteSeconds < 3_600
      ? [Math.round(elapsedSeconds / 60), 'minute']
      : absoluteSeconds < 86_400
        ? [Math.round(elapsedSeconds / 3_600), 'hour']
        : [Math.round(elapsedSeconds / 86_400), 'day'];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(amount, unit);
}

export function Timestamp({ value, relative = false }: TimestampProps) {
  const { locale } = useI18n();
  return <time dateTime={value} title={value}>{relative ? relativeTime(value, locale) : value}</time>;
}
