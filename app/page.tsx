'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Sender } from '../lib/core';
import { MAIN_ROOM, MAX_ROOMS, labelOf, type Room } from '../lib/shared';
import { RoomPane } from './pane';
import { RoomTabs, addressForRoom, roomFromSearch, readSeen, tabTitle, withSeenApplied } from './rooms';
import { SearchBox } from './search';
import { DemoBanner, DemoSignIn } from './demo';
import { DEMO_BUILD, demoLink } from '../lib/demo';
import { TokenForm } from './token';
import { SoundToggle, useRoomsElsewhere, useSoundMode } from './sound';
import { StatusBar } from './status';
import { FlightBar, readFlightPosition, writeFlightPosition, type FlightPosition } from './flight';
import { WakeTargetsLine, type ParticipantWithWake } from './wakes';
import { NewVersionPill, useWaitingLong } from './version';
import { BUILD_ID, BUILD_NUMBER, VERSION, buildLabel, isOtherBuild } from '../lib/build';
import { defaultSecondRoom, readSplit, writeSplit } from './split';
import { PaneRoomBar, SplitToggle, useSplitFits } from './split-ui';
import { TourButton, TourPanel, useTour } from './tour';
import { MoreMenu } from './more-menu';

// The key keeps its first name, so browsers that already hold a token don't have to ask for it again.
const TOKEN_KEY = 'collabHubToken';

// The demo hub, for a link in the header (TRIALOG_DEMO_URL); none on the demo hub itself.
const DEMO_LINK = demoLink();
const BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-[#2a2f3a]';

/** Until the server has said which rooms there are, the page shows the one that always exists. */
const ONLY_MAIN: Room[] = [{ id: MAIN_ROOM, name: 'Main', created_at: '', created_by: 'hub', last_id: 0 }];

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  // Where the work-in-flight strip sits; read from this browser once the page is in it.
  const [flightPosition, setFlightPosition] = useState<FlightPosition>('top');
  useEffect(() => { setFlightPosition(readFlightPosition(localStorage)); }, []);
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
  // Learn by doing: the guided tour. Both panes report the person's own actions to it (tour.note).
  // It is offered only once the leading pane's latest messages are in, so the page can tell whether
  // the person has written there before.
  const tour = useTour({ me, participants, loaded: leadHeard.primed, history: heardMessages });
  const noteTour = tour.note;

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
    noteTour({ kind: 'room' });
  }, [noteTour]);

  // A token the hub turned down: the form says so, instead of silently asking again.
  const [refused, setRefused] = useState(false);
  const saveToken = (t: string) => { localStorage.setItem(TOKEN_KEY, t); setRefused(false); setToken(t); };
  /** «Switch token»: back to the form, nothing wrong. */
  const forgetToken = useCallback(() => { localStorage.removeItem(TOKEN_KEY); setToken(''); setMe(null); }, []);
  /** The hub answered 401: back to the form, with a message. */
  const refuseToken = useCallback(() => { forgetToken(); setRefused(true); }, [forgetToken]);

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: { ...(options.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) { refuseToken(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
    return res;
  }, [token, refuseToken]);

  /** Creates a room and opens it in the leading pane. Resolves to '' when that worked, or to what went wrong. */
  /** Makes a room and opens it: in the leading pane, or with `open` where the + was pressed. */
  const createRoom = async (name: string, open: (id: string) => void = openRoom): Promise<string> => {
    try {
      const res = await api('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const created = ((await res.json()) as { room: Room }).room;
      setRooms((list) => (list.some((r) => r.id === created.id) ? list : [...list, created]));
      open(created.id);
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

  // The tab's title: what is new elsewhere, the open room, the hub's name (from the server's title).
  const hubTitle = useRef<string | null>(null);
  useEffect(() => {
    hubTitle.current ??= document.title || 'Trialog';
    const shownList = me ? withSeenApplied(rooms, readSeen(localStorage, me)) : rooms;
    document.title = tabTitle(hubTitle.current, me ? rooms.find((r) => r.id === room)?.name : undefined, shownList, openRooms);
  }, [rooms, room, openRooms, me]);
  // A message addressed to you rings from any room, even one that is not open.
  useRoomsElsewhere({ on: sound.on, rooms, open: openRooms, me, api, heard: sound.elsewhere });

  if (token === null) return null;
  if (!token) return <>{DEMO_BUILD && <DemoSignIn onPick={saveToken} />}<TokenForm onSave={saveToken} refused={refused} /></>;

  const shown = (name: string) => labelOf(name, participants);
  const reload = () => window.location.reload();
  const shownRooms = me ? withSeenApplied(rooms, readSeen(localStorage, me)) : rooms;
  const tabs = (className: string) => (
    <RoomTabs rooms={shownRooms} current={room} onPick={openRoom} onCreate={createRoom} canCreate={rooms.length < MAX_ROOMS} className={className} />
  );
  // The work-in-flight strip sits under the header or right above the message box (its «⇅»).
  // In split view there is no single message box, so it stays at the top there.
  const flightAtBottom = flightPosition === 'bottom' && !splitVisible;
  const flipFlight = () => {
    const next: FlightPosition = flightPosition === 'top' ? 'bottom' : 'top';
    writeFlightPosition(localStorage, next);
    setFlightPosition(next);
  };
  const flightBar = (
    <FlightBar token={token} onUnauthorized={refuseToken} participants={participants} position={flightAtBottom ? 'bottom' : 'top'} onFlip={splitVisible ? undefined : flipFlight} />
  );
  const statusBar = (
    <>
      {flightAtBottom && flightBar}
      <StatusBar participants={participants} token={token} onUnauthorized={refuseToken} />
    </>
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
    onUnauthorized: refuseToken,
    soundSent: sound.sent,
    onTour: noteTour,
  };

  return (
    // dvh is the height that is really visible: on a phone 100vh is taller, and the page would scroll
    // the header up under the clock. The safe-area padding keeps everything clear of the notch
    // (layout.tsx lets the page reach the screen's edges); on a computer it is 0.
    <div className={`mx-auto flex h-dvh flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] ${splitVisible ? 'max-w-[1600px]' : 'max-w-[1000px]'}`}>
      {DEMO_BUILD && <DemoBanner />}
      {/* On a narrow screen the row has no room for the pill, so the header grows by a line for it. */}
      <header className={`relative flex min-w-0 items-center gap-3 border-b border-line px-4 py-2.5 ${newVersion ? 'max-md:pb-9' : ''}`}>
        <h1 className="m-0 flex-none text-[17px] font-bold">Trialog</h1>
        <span className={`min-w-0 truncate text-[13px] ${status.startsWith('live') ? 'text-ok' : 'text-bad'}`}>● {status}</span>
        <SoundToggle on={sound.on} onToggle={sound.toggle} />
        {/* The «?» of the tour. On a phone the header is full: there it stands at the end of the rooms' row. */}
        {me && <TourButton open={tour.state.open} onToggle={tour.toggle} className="max-sm:hidden" />}
        {/* The "New version available" pill comes directly after the status, so the state of the
            page reads in one spot. On a narrow screen it sits on a line of its own, under the
            status. An empty holder takes no room in the row. */}
        <span role="status" className={`max-md:contents md:flex ${newVersion ? '' : 'md:-mr-3'}`}>
          {newVersion && <NewVersionPill onReload={reload} accent={newVersionWaitsLong} className="max-md:absolute max-md:bottom-2 max-md:left-4" />}
        </span>
        {/* The rooms come after the state of the page: the open one marked, the others with what is new there. */}
        {/* With two panes, each pane has its own room bar instead, so both rooms start on one line. */}
        {!splitVisible && tabs('hidden lg:flex lg:max-w-[42%]')}
        <SplitToggle on={splitOn} onToggle={toggleSplit} disabled={!fits} />
        {/* The search field takes the free space of the header (a magnifier button on a narrow screen). */}
        <SearchBox
          search={runSearch}
          onPick={(m) => { if (m.room !== room) openRoom(m.room); setSeek({ room: m.room, id: m.id }); }}
          participants={participants}
          rooms={rooms}
        />
        {/* On a phone there is no room for these three: «You» is left out, the two buttons go into «⋯». */}
        {me && <span className="min-w-0 truncate text-[13px] font-semibold max-sm:hidden">You: {shown(me)}</span>}
        <button className={`${BUTTON} flex-none max-sm:hidden`} onClick={() => { void exportTranscript(); }}>Export .md</button>
        <button className={`${BUTTON} flex-none bg-transparent max-sm:hidden`} onClick={forgetToken}>Switch token</button>
        <a className={`${BUTTON} flex-none bg-transparent text-fg no-underline max-sm:hidden`} href="/roadmap" target="trialog-roadmap" title="The roadmap: drag to reorder, in its own tab">Roadmap ↗</a>
        {DEMO_LINK && <a className={`${BUTTON} flex-none bg-transparent text-fg no-underline max-sm:hidden`} href={DEMO_LINK} target="_blank" rel="noopener noreferrer" title="The demo hub: public tokens, try anything">Demo hub ↗</a>}
        <MoreMenu
          className="sm:hidden"
          items={[
            { label: 'Export .md', onPick: () => { void exportTranscript(); } },
            { label: 'Switch token', onPick: forgetToken },
            { label: 'Roadmap', href: '/roadmap', target: 'trialog-roadmap' },
            ...(DEMO_LINK ? [{ label: 'Demo hub', href: DEMO_LINK }] : []),
          ]}
        />
      </header>
      {/* On a narrower screen the rooms have a row of their own, which scrolls sideways. */}
      <div className={`flex items-center gap-2 border-b border-line px-4 py-1.5 lg:hidden ${splitVisible ? 'hidden' : ''}`}>
        {tabs('flex min-w-0 flex-1')}
        {me && <TourButton open={tour.state.open} onToggle={tour.toggle} className="sm:hidden" />}
      </div>
      {!flightAtBottom && flightBar}
      <TourPanel tour={tour} me={me} participants={participants} />
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
            picker={<PaneRoomBar side="lead" rooms={shownRooms} current={room} onPick={openRoom} onCreate={createRoom} canCreate={rooms.length < MAX_ROOMS} />}
          />
          <div className="w-px shrink-0 bg-line" aria-hidden="true" />
          <RoomPane
            {...paneShared}
            room={secondRoom}
            roomInfo={rooms.find((r) => r.id === secondRoom)}
            onMissingRoom={onMissingSecond}
            onHeard={onSideHeard}
            picker={
              <PaneRoomBar
                side="side" rooms={shownRooms} current={secondRoom} canCreate={rooms.length < MAX_ROOMS}
                onPick={(id) => { setSecondRoom(id); noteTour({ kind: 'room' }); }}
                onCreate={(name) => createRoom(name, setSecondRoom)}
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
      {/* Which version this is, in words people remember: «Trialog v0.3 · build 51». */}
      {buildLabel(VERSION, BUILD_NUMBER) && (
        <div className="shrink-0 px-4 pb-1 text-right text-[11px] text-muted">{buildLabel(VERSION, BUILD_NUMBER)}</div>
      )}
    </div>
  );
}
