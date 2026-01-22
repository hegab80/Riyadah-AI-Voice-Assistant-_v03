
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionStatus, MessageLog } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio';
import { queryKnowledgeBase, submitSupportAction } from './services/riyadahApi';
import { Visualizer } from './components/Visualizer';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const HelpDeskIcon = () => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    width="20" 
    height="20" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className="text-white"
  >
    <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/>
    <path d="M21 16v2a2 2 0 0 1-2 2h-5"/>
  </svg>
);

const knowledgeBaseTool: FunctionDeclaration = {
  name: 'query_knowledge_base',
  parameters: {
    type: Type.OBJECT,
    description: 'Query Riyadah knowledge base for information about company services and products.',
    properties: {
      query: { type: Type.STRING, description: 'The user query to search for.' },
      sessionId: { type: Type.STRING, description: 'A unique session ID.' }
    },
    required: ['query', 'sessionId'],
  },
};

const bookMeetingTool: FunctionDeclaration = {
  name: 'book_meeting',
  parameters: {
    type: Type.OBJECT,
    description: 'Schedule a professional meeting or appointment for the customer.',
    properties: {
      name: { type: Type.STRING, description: 'Customer full name.' },
      phone: { type: Type.STRING, description: 'Phone number.' },
      email: { type: Type.STRING, description: 'Email address.' },
      datetime: { type: Type.STRING, description: 'Preferred date and time.' },
      purpose: { type: Type.STRING, description: 'Reason for the meeting.' }
    },
    required: ['name', 'phone', 'email', 'datetime', 'purpose'],
  },
};

const createTicketTool: FunctionDeclaration = {
  name: 'create_support_ticket',
  parameters: {
    type: Type.OBJECT,
    description: 'Create a support ticket or log a complaint for the customer.',
    properties: {
      name: { type: Type.STRING, description: 'Customer full name.' },
      phone: { type: Type.STRING, description: 'Phone number.' },
      email: { type: Type.STRING, description: 'Email address.' },
      type: { type: Type.STRING, description: 'Either "Support" or "Complaint".' },
      description: { type: Type.STRING, description: 'Detailed description of the issue.' }
    },
    required: ['name', 'phone', 'email', 'type', 'description'],
  },
};

const logSalesInterestTool: FunctionDeclaration = {
  name: 'log_sales_interest',
  parameters: {
    type: Type.OBJECT,
    description: 'Log a customer interest in a product or service for sales follow-up.',
    properties: {
      name: { type: Type.STRING, description: 'Customer full name.' },
      phone: { type: Type.STRING, description: 'Phone number.' },
      email: { type: Type.STRING, description: 'Email address.' },
      interest: { type: Type.STRING, description: 'What specific product or service are they interested in?' }
    },
    required: ['name', 'phone', 'email', 'interest'],
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionId] = useState(() => `sess_${Math.random().toString(36).substring(2, 10)}`);

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const gainNodeOutRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setStatus('disconnected');
    setIsListening(false);
    setIsSpeaking(false);
  }, []);

  const connect = async () => {
    try {
      setStatus('connecting');
      setErrorMsg(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      if (!audioContextInRef.current) {
        audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!audioContextOutRef.current) {
        audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      await audioContextInRef.current.resume();
      await audioContextOutRef.current.resume();

      if (!gainNodeOutRef.current) {
        gainNodeOutRef.current = audioContextOutRef.current.createGain();
        gainNodeOutRef.current.connect(audioContextOutRef.current.destination);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const dynamicSystemInstruction = `You are Riyadah's AI Voice Assistant, a helpful representative of Riyadah Ltd.

Core Identity & Pronunciation Rules:
- Company Name: "Riyadah" (Arabic: رِيَــادَة).
- Meaning: The name means "Leadership" or "Pioneering" in an enterprise context.
- Context: Riyadah is a Technology Integrator and Infrastructure company.
- FORBIDDEN: NEVER refer to "Sports" (رياضة). We are NOT a sports club.
- Arabic Linguistic Rule: When speaking Arabic, you MUST pronounce/write it with the letter 'Dal' (د), not 'Dad' (ض). Use the diacritics: "رِيَـادَة". NEVER say or write "رياضة".

Protocol:
1. Knowledge: Use 'query_knowledge_base' for all info.
2. Logging: For bookings, tickets, or sales, gather FULL name, phone, and email FIRST.
3. Actions: Once info is gathered, call the appropriate tool. Confirm to the user when finished.

Tone: Professional, bilingual (Arabic/English). Be concise.`;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus('connected');
            setIsListening(true);
            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            scriptProcessorRef.current = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(s => {
                if (s) s.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };
            source.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextOutRef.current) {
              setIsSpeaking(true);
              const audioBuffer = await decodeAudioData(decode(audioData), audioContextOutRef.current, 24000, 1);
              const source = audioContextOutRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(gainNodeOutRef.current!);
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContextOutRef.current.currentTime);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              
              sourcesRef.current.add(source);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                let responseResult = "Action successful.";
                try {
                  if (fc.name === 'query_knowledge_base') {
                    const res = await queryKnowledgeBase(fc.args.query as string, sessionId);
                    responseResult = JSON.stringify(res);
                  } else if (fc.name === 'book_meeting') {
                    await submitSupportAction({
                      messageType: 'Booking',
                      actionDone: 'Appointment Scheduled',
                      clientName: fc.args.name as string,
                      phone: fc.args.phone as string,
                      email: fc.args.email as string,
                      topic: `Purpose: ${fc.args.purpose}, Time: ${fc.args.datetime}`
                    });
                  } else if (fc.name === 'create_support_ticket') {
                    await submitSupportAction({
                      messageType: 'Support Ticket',
                      actionDone: 'Support Ticket Logged',
                      clientName: fc.args.name as string,
                      phone: fc.args.phone as string,
                      email: fc.args.email as string,
                      topic: `${fc.args.type}: ${fc.args.description}`
                    });
                  } else if (fc.name === 'log_sales_interest') {
                    await submitSupportAction({
                      messageType: 'Sales Query',
                      actionDone: 'Sales info Delivered',
                      clientName: fc.args.name as string,
                      phone: fc.args.phone as string,
                      email: fc.args.email as string,
                      topic: `Interest in: ${fc.args.interest}`
                    });
                  }
                } catch (e: any) {
                  responseResult = `Error: ${e.message}`;
                }

                sessionPromise.then(s => {
                  s.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: fc.name,
                      response: { result: responseResult }
                    }]
                  });
                });
              }
            }
          },
          onerror: (e) => {
            console.error('WebSocket Error:', e);
            setErrorMsg("Call ended. Possible connection issue.");
            setStatus('error');
            cleanup();
          },
          onclose: () => cleanup(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: dynamicSystemInstruction,
          tools: [{ functionDeclarations: [knowledgeBaseTool, bookMeetingTool, createTicketTool, logSalesInterestTool] }],
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to establish voice session.");
      setStatus('error');
      cleanup();
    }
  };

  return (
    <div className="h-screen w-full bg-white flex flex-col overflow-hidden">
      {/* Absolute top header for seamless iframe embedding */}
      <header className="bg-slate-900 px-6 py-4 text-white flex justify-between items-center shrink-0 w-full shadow-lg z-20">
        <div className="flex items-center space-x-3">
          <HelpDeskIcon />
          <div>
            <h1 className="text-base font-bold leading-none tracking-tight">Riyadah Voice</h1>
            <span className="text-[9px] text-cyan-400 font-bold tracking-widest uppercase">AI Assistant</span>
          </div>
        </div>
        <div className="flex items-center space-x-2 bg-slate-800 px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider">
          <div className={`w-1.5 h-1.5 rounded-full ${status === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`} />
          <span className="text-slate-300">{status}</span>
        </div>
      </header>

      {/* Main content filling the height */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 space-y-10 overflow-hidden">
        <div className="text-center animate-fadeIn">
          <h2 className="text-2xl font-bold text-slate-800 mb-1">Welcome to Riyadah</h2>
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">Professional Voice AI Service</p>
        </div>

        <div className="relative group">
          <div className={`absolute -inset-16 bg-cyan-100/30 rounded-full blur-3xl transition-all duration-1000 ${isSpeaking || isListening ? 'scale-125 opacity-100' : 'scale-50 opacity-0'}`} />
          <div className="relative z-10 w-48 h-48 bg-white rounded-full shadow-2xl flex items-center justify-center border border-slate-50">
             <Visualizer active={isSpeaking || isListening} color={isSpeaking ? 'bg-cyan-500' : 'bg-green-500'} />
          </div>
        </div>

        <div className="w-full flex flex-col items-center space-y-4 pb-4">
          <button
            onClick={status === 'connected' || status === 'connecting' ? cleanup : connect}
            disabled={status === 'connecting'}
            className={`group relative px-12 py-4 rounded-full font-bold text-base shadow-xl transition-all transform active:scale-95 ${
              status === 'connected' || status === 'connecting'
                ? 'bg-red-50 text-red-600 border border-red-100 hover:bg-red-100'
                : 'bg-slate-900 text-white hover:bg-black shadow-slate-200'
            }`}
          >
            <span className="flex items-center space-x-3">
              {status === 'connecting' ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>Connecting...</span>
                </>
              ) : status === 'connected' ? (
                'End Conversation'
              ) : (
                'Start Interaction'
              )}
            </span>
          </button>

          {errorMsg && (
            <div className="max-w-xs text-center p-3 bg-red-50 text-red-700 rounded-xl text-[10px] font-bold border border-red-100 uppercase tracking-tight">
              {errorMsg}
            </div>
          )}
        </div>
      </main>

      {/* Footer snapping to bottom */}
      <footer className="bg-slate-50 px-6 py-4 border-t border-slate-100 text-center shrink-0 w-full">
        <p className="text-slate-400 text-[9px] font-bold uppercase tracking-[0.3em] leading-relaxed">
          © 2026 Riyadah Ltd. <br/>
          Hotline: (+2) 0155-155-3285 • Cairo, Egypt
        </p>
      </footer>
    </div>
  );
};

export default App;
