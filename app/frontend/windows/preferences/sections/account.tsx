'use client';

import { useState, useEffect } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { useUserSettings } from '../../../hooks/useUserSettings';
import { cn } from '../../../lib/utils';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Field, SectionHeader, FIELD_INPUT_CLASS, FIELD_DESC_CLASS } from './primitives';

export function AccountSection() {
  const { settings, updateSettings } = useUserSettings();
  const [isEditingName, setIsEditingName] = useState(false);
  const [name, setName] = useState(settings.userName);
  const [isUploading] = useState(false);

  // Update local name when settings load
  useEffect(() => {
    setName(settings.userName);
  }, [settings.userName]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Profile"
        description="Manage your account identity and contact info"
      />

      <div className="flex items-center gap-4">
        <div className="relative">
          <div className="w-20 h-20 rounded-full bg-[var(--primary)]/10 flex items-center justify-center">
            <span className="text-2xl font-medium text-[var(--primary)]">
              {settings.userName.charAt(0).toUpperCase()}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 hover:opacity-100"
          >
            {isUploading ? (
              <Loader2 className="w-6 h-6 text-white animate-spin" />
            ) : (
              <Camera className="w-6 h-6 text-white" />
            )}
          </Button>
        </div>

        <div className="flex-1 min-w-0">
          {isEditingName ? (
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setIsEditingName(false);
                if (name !== settings.userName) {
                  updateSettings({ userName: name });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setIsEditingName(false);
                  if (name !== settings.userName) {
                    updateSettings({ userName: name });
                  }
                }
              }}
              autoFocus
              className={cn('text-lg font-medium h-9', FIELD_INPUT_CLASS)}
            />
          ) : (
            <div
              onClick={() => setIsEditingName(true)}
              className="text-lg font-medium text-[var(--foreground)] cursor-pointer hover:text-[var(--primary)] transition-colors inline-flex items-center gap-2"
            >
              {settings.userName}
              <span className={FIELD_DESC_CLASS}>(click to edit)</span>
            </div>
          )}
          <p className={cn(FIELD_DESC_CLASS, 'mt-1')}>Click nickname to edit</p>
        </div>
      </div>

      <Field title="Email" description="Used for account notifications">
        <div className={cn(
          'flex items-center gap-3 p-3 rounded-lg border',
          FIELD_INPUT_CLASS
        )}>
          <div className="flex-1 min-w-0 truncate text-sm text-[var(--foreground)]">
            {settings.userEmail || (
              <span className="text-[var(--muted-foreground)]">Not set</span>
            )}
          </div>
        </div>
      </Field>
    </div>
  );
}
