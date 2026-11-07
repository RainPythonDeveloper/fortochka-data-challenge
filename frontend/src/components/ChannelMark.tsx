import { MessageSquare, Phone } from 'lucide-react';
import { channelLabel } from '../lib/format';

/** The channel and language as plain text: they describe a dialogue, they are not statuses. */
export function ChannelMark({ channel, language }: { channel: string; language: string }) {
  const Icon = channel === 'voice call' ? Phone : MessageSquare;
  return (
    <span className="channel">
      <Icon size={15} strokeWidth={1.75} aria-hidden />
      {channelLabel(channel)}
      <span className="channel__sep" aria-hidden>·</span>
      {language}
    </span>
  );
}
