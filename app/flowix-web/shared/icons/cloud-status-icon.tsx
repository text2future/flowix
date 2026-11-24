export type CloudStatus = 'unlinked' | 'connected' | 'upload' | 'download';

interface CloudStatusIconProps {
  status: CloudStatus;
  size?: number;
  className?: string;
}

// CloudArrowDownIcon (regular) split into a fixed cloud frame and overlays.
// All statuses reuse CLOUD_FRAME_PATH, so changing the arrow / check / slash
// never changes the cloud's bounds or vertical center.
const CLOUD_FRAME_PATH =
  'M248,128a87.34,87.34,0,0,1-17.6,52.81,8,8,0,1,1-12.8-9.62A71.34,71.34,0,0,0,232,128a72,72,0,0,0-144,0,8,8,0,0,1-16,0,88,88,0,0,1,3.29-23.88C74.2,104,73.1,104,72,104a48,48,0,0,0,0,96H96a8,8,0,0,1,0,16H72A64,64,0,1,1,81.29,88.68,88,88,0,0,1,248,128Z';
const CLOUD_ARROW_DOWN_PATH =
  'M178.34,170.34L160,188.69V128a8,8,0,0,0-16,0v60.69l-18.34-18.35a8,8,0,0,0-11.32,11.32l32,32a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0-11.32-11.32Z';
const CLOUD_ARROW_UP_PATH =
  'M178.34,165.66L160,147.31V208a8,8,0,0,1-16,0v-60.69l-18.34,18.35a8,8,0,0,1-11.32-11.32l32-32a8,8,0,0,1,11.32,0l32,32a8,8,0,0,1-11.32,11.32Z';
const CLOUD_CHECK_PATH =
  'M197.66,106.34a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L144,148.69l42.34-42.35A8,8,0,0,1,197.66,106.34Z';
const CLOUD_FRAME_CLOSURE_PATH =
  'M96,200H160a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16Z';

/** Shared Cloud family mark used by desktop notebook controls. */
export function CloudStatusIcon({ status, size = 21, className }: CloudStatusIconProps) {
  const classes = [
    'flowix-cloud-status-icon',
    `flowix-cloud-status-icon--${status}`,
    className,
  ].filter(Boolean).join(' ');

  return (
    <span className={classes} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={CLOUD_FRAME_PATH} />
        {status === 'unlinked' && (
          <>
            <path d={CLOUD_FRAME_CLOSURE_PATH} />
            <path
              d="M48,40L208,216"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="16"
            />
          </>
        )}
        {status === 'connected' && (
          <>
            <path d={CLOUD_FRAME_CLOSURE_PATH} />
            <path d={CLOUD_CHECK_PATH} />
          </>
        )}
        {status === 'download' && <path d={CLOUD_ARROW_DOWN_PATH} />}
        {status === 'upload' && <path d={CLOUD_ARROW_UP_PATH} />}
      </svg>
    </span>
  );
}
