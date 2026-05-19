import React from 'react';

export default function HoverRevealText({ children, className = '', revealClassName = '', rootClassName = '', text }) {
  const content = children ?? text ?? '';
  const title = typeof text === 'string' ? text : typeof children === 'string' ? children : '';

  return (
    <span className={`hover-reveal-text ${rootClassName}`.trim()} title={title}>
      <span className={className}>{content}</span>
      <span aria-hidden="true" className={`hover-reveal-popover ${revealClassName}`.trim()}>
        {content}
      </span>
    </span>
  );
}
