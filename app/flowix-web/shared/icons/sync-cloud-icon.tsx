import { useId } from 'react';

const CLOUD_PATH = 'M9.5 6C5.91015 6 3 8.91015 3 12.5C3 16.0899 5.91015 19 9.5 19H16.5C18.9853 19 21 16.9853 21 14.5C21 12.0147 18.9853 10 16.5 10C16.1717 10 15.8516 10.0352 15.5433 10.1019C14.589 7.69894 12.2429 6 9.5 6ZM16.5 21H9.5C4.80558 21 1 17.1944 1 12.5C1 7.80558 4.80558 4 9.5 4C12.5433 4 15.2131 5.59939 16.7146 8.00348C20.2051 8.11671 23 10.982 23 14.5C23 18.0899 20.0899 21 16.5 21Z';

export function SyncCloudIcon({ variant, className }: { variant: 'cloud' | 'off' | 'alert'; className?: string }) {
  const maskId = useId();
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
      className={className} aria-hidden="true">
      {variant === 'off' && (
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <path d="M3 6L21 21" fill="none" stroke="black" strokeWidth="5" strokeLinecap="round" />
        </mask>
      )}
      <path d={CLOUD_PATH} stroke="currentColor" strokeWidth="0.133" strokeLinejoin="round" mask={variant === 'off' ? `url(#${maskId})` : undefined} />
      {variant === 'off' && <path d="M3 6L21 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
      {variant === 'alert' && (
        <>
          <path d="M12 10.5v3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="1" />
        </>
      )}
    </svg>
  );
}
