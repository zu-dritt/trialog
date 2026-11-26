'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Sender } from '../lib/core';
import { MAIN_ROOM, MAX_ROOMS, labelOf, type Room } from '../lib/shared';
import { RoomPane, RoomPicker } from './pane';
import { RoomTabs, addressForRoom, roomFromSearch, readSeen, withSeenApplied } from './rooms';
import { SearchBox } from './search';
import { SoundToggle, useSoundMode } from './sound';
import { StatusBar } from './status';
import { WakeTargetsLine, type ParticipantWithWake } from './wakes';
import { NewVersionPill, useWaitingLong } from './version';
import { BUILD_ID, isOtherBuild } from '../lib/build';
import { defaultSecondRoom, readSplit, writeSplit } from './split';
import { SplitToggle, useSplitFits } from './split-ui';

// The key keeps its first name, so browsers that already hold a token don't have to ask for it again.
const TOKEN_KEY = 'collabHubToken';

const BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-[#2a2f3a]';

/** Until the server has said which rooms there are, the page shows the one that always exists. */
const ONLY_MAIN: Room[] = [{ id: MAIN_ROOM, name: 'Main', created_at: '', created_by: 'hub', last_id: 0 }];

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function TokenForm({ onSave }: { onSave: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="mx-auto mt-[18vh] max-w-[420px] px-4">
      <h1 className="my-[0.67em] text-[2em] font-bold">Trialog</h1>
      <p className="my-4 text-muted">Paste your token once. It stays in this browser (localStorage) and is only sent to this site.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSave(value.trim()); }}>
        <input
          type="password" autoFocus autoComplete="off" placeholder="Token" value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-line bg-panel px-2.5 py-[7px]"
        />
        <button type="submit" className={BUTTON}>Open hub</button>
      </form>
    </main>
  );
}

export default function Page() {
  const [token, setToken] = useState<string | null>(null); // null: not read yet; '': none saved
  const [me, setMe] = useState<Sender | null>(null);
  // The room that is open in the leading pane. The address follows this room, so a reload stays there.
  const [room, setRoom] = useState(MAIN_ROOM);
  const [rooms, setRooms] = useState<Room[]>(ONLY_MAIN);
  const roomRef = useRef(MAIN_ROOM);
  roomRef.current = room;
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const [, setSeenChanged] = useState(0); // another window of this browser has seen something: draw the tabs again
  const [status, setStatus] = useState('connecting…');
  const [serverBuild, setServerBuild] = useState<string | null>(null); // the build the server says it runs
  const newVersion = isOtherBuild(BUILD_ID, serverBuild);
  const newVersionWaitsLong = useWaitingLong(newVersion);
  const [participants, setParticipants] = useState<ParticipantWithWake[]>([]);
  const [setupError, setSetupError] = useState(''); // the server's settings can't be used; it says which
  const [pageNotice, setPageNotice] = useState('');
  const [splitOn, setSplitOn] = useState(false);
  const [secondRoom, setSecondRoom] = useState(MAIN_ROOM);
  const [splitReady, setSplitReady] = useState(false);
  const [seek, setSeek] = useState<{ room: string; id: number } | null>(null);
  const [leadHeard, setLeadHeard] = useState<{ messages: Message[]; primed: boolean }>({ messages: [], primed: false });
  const [sideHeard, setSideHeard] = useState<{ messages: Message[]; primed: boolean }>({ messages: [], primed: false });
  const fits = useSplitFits();
  const splitVisible = splitOn && fits;
  const heardMessages = useMemo(() => {
    const byId = new Map(leadHeard.messages.map((m) => [m.id, m]));
    if (splitVisible) for (const m of sideHeard.messages) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [leadHeard.messages, sideHeard.messages, splitVisible]);
  const primed = leadHeard.primed && (!splitVisible || sideHeard.primed);
  const sound = useSoundMode({ messages: heardMessages, me, participants, primed, newVersion });
  const onLeadHeard = useCallback((messages: Message[], next: boolean) => setLeadHeard({ messages, primed: next }), []);
  const onSideHeard = useCallback((messages: Message[], next: boolean) => setSideHeard({ messages, primed: next }), []);

  // The address says which room to open. Read together with the token, so the page opens once, in that room.
  useEffect(() => {
    setRoom(roomFromSearch(window.location.search));
    setToken(localStorage.getItem(TOKEN_KEY) || '');
    // Back and forward in the browser move between the rooms that were open.
    const onPop = () => setRoom(roomFromSearch(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The stored split choice is per participant, and starts off when none has been kept.
  useEffect(() => {
    if (!me) {
      setSplitReady(false);
      setSplitOn(false);
      setSecondRoom(MAIN_ROOM);
      return undefined;
    }
    const pref = readSplit(localStorage, me);
    setSplitOn(pref.open);
    setSecondRoom(pref.room);
    setSplitReady(true);
  }, [me]);

  useEffect(() => {
    if (!me || !splitReady) return undefined;
    writeSplit(localStorage, me, { open: splitOn, room: secondRoom });
    return undefined;
  }, [me, splitOn, secondRoom, splitReady]);

  // Two panes of the same room are not useful: if the left is opened onto the right, pick another.
  useEffect(() => {
    if (!splitOn || secondRoom !== room) return undefined;
    const next = defaultSecondRoom(rooms, room);
    if (next !== secondRoom) setSecondRoom(next);
    return undefined;
  }, [splitOn, room, secondRoom, rooms]);

  useEffect(() => {
    if (splitVisible) return undefined;
    setSideHeard({ messages: [], primed: false });
    return undefined;
  }, [splitVisible]);

  /** Opens another room in the leading pane. The address follows, so a reload stays there and the link can be shared. */
  const openRoom = useCallback((id: string) => {
    if (id === roomRef.current) return;
    window.history.pushState(null, '', addressForRoom(window.location.href, id));
    setRoom(id);
  }, []);

  const saveToken = (t: string) => { localStorage.setItem(TOKEN_KEY, t); setToken(t); };
  const forgetToken = useCallback(() => { localStorage.removeItem(TOKEN_KEY); setToken(''); setMe(null); }, []);

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: { ...(options.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) { forgetToken(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
    return res;
  }, [token, forgetToken]);

  /** Creates a room and opens it in the leading pane. Resolves to '' when that worked, or to what went wrong. */
  const createRoom = async (name: string): Promise<string> => {
    try {
      const res = await api('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const created = ((await res.json()) as { room: Room }).room;
      setRooms((list) => (list.some((r) => r.id === created.id) ? list : [...list, created]));
      openRoom(created.id);
      return '';
    } catch (e) {
      return errorMessage(e) === 'unauthorized' ? 'Not signed in.' : errorMessage(e);
    }
  };

  /** Asks the server for the messages that contain every word of `q`. */
  const runSearch = useCallback(async (q: string, decisionsOnly: boolean) => {
    const params = new URLSearchParams({ q });
    if (decisionsOnly) params.set('decisions', '1');
    return ((await (await api(`/api/messages?${params.toString()}`)).json()) as { messages: Message[] }).messages;
  }, [api]);

  const exportTranscript = async () => {
    try {
      // The transcript of the room in the leading pane (the one the address names).
      const blob = await (await api(`/api/export${room === MAIN_ROOM ? '' : `?room=${room}`}`)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trialog-${room === MAIN_ROOM ? '' : `${room}-`}${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setPageNotice(errorMessage(e));
    }
  };

  const toggleSplit = () => {
    setSplitOn((on) => {
      if (on) return false;
      setSecondRoom((cur) => (cur === roomRef.current ? defaultSecondRoom(roomsRef.current, roomRef.current) : cur));
      return true;
    });
  };

  const onMissingPrimary = useCallback((_missing: string) => {
    window.history.replaceState(null, '', addressForRoom(window.location.href, MAIN_ROOM));
    setRoom(MAIN_ROOM);
  }, []);

  const onMissingSecond = useCallback((missing: string) => {
    setSecondRoom(() => defaultSecondRoom(roomsRef.current.filter((r) => r.id !== missing), roomRef.current === missing ? MAIN_ROOM : roomRef.current));
  }, []);

  const openRooms = useMemo(
    () => (splitVisible ? [room, secondRoom] : [room]),
    [splitVisible, room, secondRoom],
  );

  if (token === null) return null;
  if (!token) return <TokenForm onSave={saveToken} />;

  const shown = (name: string) => labelOf(name, participants);
  const reload = () => window.location.reload();
  const shownRooms = me ? withSeenApplied(rooms, readSeen(localStorage, me)) : rooms;
  const tabs = (className: string) => (
    <RoomTabs rooms={shownRooms} current={room} onPick={openRoom} onCreate={createRoom} canCreate={rooms.length < MAX_ROOMS} className={className} />
  );
  const statusBar = (
    <StatusBar participants={participants} token={token} onUnauthorized={forgetToken} />
  );
  const paneShared = {
    token,
    api,
    me,
    setMe,
    participants,
    setParticipants,
    setRooms,
    setSeenChanged,
    openRooms,
    onUnauthorized: forgetToken,
    soundSent: sound.sent,
  };

  return (
    <div className={`mx-auto flex h-screen flex-col ${splitVisible ? 'max-w-[1600px]' : 'max-w-[1000px]'}`}>
      {/* On a narrow screen the row has no room for the pill, so the header grows by a line for it. */}
      <header className={`relative flex items-center gap-3 border-b border-line px-4 py-2.5 ${newVersion ? 'max-md:pb-9' : ''}`}>
        <h1 className="m-0 text-[17px] font-bold">Trialog</h1>
        <span className={`text-[13px] ${status.startsWith('live') ? 'text-ok' : 'text-bad'}`}>● {status}</span>
        <SoundToggle on={sound.on} onToggle={sound.toggle} />
        {/* The "New version available" pill comes directly after the status, so the state of the
            page reads in one spot. On a narrow screen it sits on a line of its own, under the
            status. An empty holder takes no room in the row. */}
        <span role="status" className={`max-md:contents md:flex ${newVersion ? '' : 'md:-mr-3'}`}>
          {newVersion && <NewVersionPill onReload={reload} accent={newVersionWaitsLong} className="max-md:absolute max-md:bottom-2 max-md:left-4" />}
        </span>
        {/* The rooms come after the state of the page: the open one marked, the others with what is new there. */}
        {tabs('hidden lg:flex lg:max-w-[42%]')}
        <SplitToggle on={splitOn} onToggle={toggleSplit} disabled={!fits} />
        {/* The search field takes the free space of the header (a magnifier button on a narrow screen). */}
        <SearchBox
          search={runSearch}
          onPick={(m) => { if (m.room !== room) openRoom(m.room); setSeek({ room: m.room, id: m.id }); }}
          participants={participants}
          rooms={rooms}
        />
        {me && <span className="text-[13px] font-semibold">You: {shown(me)}</span>}
        <button className={BUTTON} onClick={() => { void exportTranscript(); }}>Export .md</button>
        <button className={`${BUTTON} bg-transparent`} onClick={forgetToken}>Switch token</button>
      </header>
      {/* On a narrower screen the rooms have a row of their own, which scrolls sideways. */}
      <div className="border-b border-line px-4 py-1.5 lg:hidden">{tabs('flex')}</div>
      <WakeTargetsLine me={me} participants={participants} />
      {pageNotice && <div className="border-b border-line px-4 py-1.5 text-[13px] text-bad">{pageNotice}</div>}
      {splitVisible && statusBar}

      {splitVisible ? (
        <div className="flex min-h-0 flex-1">
          <RoomPane
            {...paneShared}
            lead
            room={room}
            roomInfo={rooms.find((r) => r.id === room)}
            setServerBuild={setServerBuild}
            setStatus={setStatus}
            setSetupError={setSetupError}
            setupError={setupError}
            onMissingRoom={onMissingPrimary}
            seek={seek}
            onJumped={() => setSeek(null)}
            onHeard={onLeadHeard}
          />
          <div className="w-px shrink-0 bg-line" aria-hidden="true" />
          <RoomPane
            {...paneShared}
            room={secondRoom}
            roomInfo={rooms.find((r) => r.id === secondRoom)}
            onMissingRoom={onMissingSecond}
            onHeard={onSideHeard}
            picker={
              <RoomPicker
                rooms={shownRooms}
                current={secondRoom}
                onPick={setSecondRoom}
              />
            }
          />
        </div>
      ) : (
        <RoomPane
          {...paneShared}
          lead
          room={room}
          roomInfo={rooms.find((r) => r.id === room)}
          setServerBuild={setServerBuild}
          setStatus={setStatus}
          setSetupError={setSetupError}
          setupError={setupError}
          onMissingRoom={onMissingPrimary}
          seek={seek}
          onJumped={() => setSeek(null)}
          onHeard={onLeadHeard}
          statusBar={statusBar}
        />
      )}
    </div>
  );
}
