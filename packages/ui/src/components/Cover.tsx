import { useState } from 'react';

interface Props {
  src?: string;
  title: string;
  className: string;
}

/** 封面组件：加载失败时退化成首字占位块 */
export default function Cover({ src, title, className }: Props) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return <span className={className + ' placeholder'}>{title.slice(0, 1)}</span>;
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
