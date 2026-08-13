'use client';

// CSV file dropzone — the suite's DropzoneShell with CSV-specific copy and states.

import * as React from 'react';
import { UploadCloudIcon, FileTextIcon } from 'lucide-react';

import { DropzoneShell } from '@/components/dropzone';

interface CsvDropzoneProps {
  fileName: string | null;
  rowCount: number;
  onFile: (file: File) => void;
}

export function CsvDropzone({ fileName, rowCount, onFile }: CsvDropzoneProps) {
  return (
    <DropzoneShell accept=".csv,text/csv" onFiles={(files) => onFile(files[0])}>
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
    </DropzoneShell>
  );
}
