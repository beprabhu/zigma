'use client';

// CSV file dropzone — custom component (no shadcn equivalent), styled with Luma tokens.

import * as React from 'react';
import { UploadCloudIcon, FileTextIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CsvDropzoneProps {
  fileName: string | null;
  rowCount: number;
  onFile: (file: File) => void;
}

export function CsvDropzone({ fileName, rowCount, onFile }: CsvDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [drag, setDrag] = React.useState(false);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground transition-colors',
        drag && 'border-primary bg-accent',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {fileName ? (
        <>
          <FileTextIcon className="size-6" />
          <span>
            <strong className="text-foreground">{fileName}</strong>
            {' — '}{rowCount} row{rowCount === 1 ? '' : 's'}
          </span>
        </>
      ) : (
        <>
          <UploadCloudIcon className="size-6" />
          <span>Drop CSV here or <u className="text-primary">browse</u></span>
        </>
      )}
    </div>
  );
}
