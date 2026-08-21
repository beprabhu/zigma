// Home is the file browser now, not a launcher.
//
// It used to be four cards saying "Open Compose", which was the only thing it could be when no
// tool remembered anything. Now every tool autosaves into a named file, so the useful thing to
// show on arrival is the work itself — and the launcher survives as the empty state, which is the
// only moment it was ever the most useful thing on the screen.

import { FilesHome } from '@/components/home/files-home';

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <FilesHome />
    </div>
  );
}
