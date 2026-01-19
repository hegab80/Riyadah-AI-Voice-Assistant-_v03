
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { ConnectionStatus, MessageLog } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio';
import { queryKnowledgeBase, submitSupportAction } from './services/riyadahApi';
import { Visualizer } from './components/Visualizer';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

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
  const [transcripts, setTranscripts] = useState<MessageLog[]>([]);
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
            // Audio Output handling
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

            // Function Call handling
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
            setErrorMsg("Connection issue or internal model error. Please restart.");
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
          // Transcriptions disabled to avoid Internal Error 500 in preview model
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
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-12 px-4">
      <div className="max-w-2xl w-full bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-100 flex flex-col min-h-[600px]">
        <header className="bg-slate-900 px-8 py-6 text-white flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-600 w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xl shadow-lg">R</div>
            <div>
              <h1 className="text-lg font-bold leading-none">Riyadah Voice</h1>
              <span className="text-[10px] text-blue-400 font-bold tracking-widest uppercase">AI Assistant</span>
            </div>
          </div>
          <div className="flex items-center space-x-2 bg-slate-800 px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
            <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`} />
            <span className="text-slate-300">{status}</span>
          </div>
        </header>

        <main className="p-10 flex-1 flex flex-col items-center justify-center space-y-12">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-slate-800 mb-2 arabic">مرحباً بك في رياده</h2>
            <p className="text-slate-500 text-sm">Bilingual Professional Voice Agent</p>
          </div>

          <div className="relative">
            <div className={`absolute -inset-8 bg-blue-100/50 rounded-full blur-2xl transition-all duration-1000 ${isSpeaking || isListening ? 'scale-110 opacity-100' : 'scale-90 opacity-0'}`} />
            <div className="relative z-10 w-48 h-48 bg-white rounded-full shadow-inner flex items-center justify-center border-4 border-slate-50">
               <Visualizer active={isSpeaking || isListening} color={isSpeaking ? 'bg-blue-600' : 'bg-green-500'} />
            </div>
          </div>

          <div className="w-full flex flex-col items-center space-y-6">
            <button
              onClick={status === 'connected' || status === 'connecting' ? cleanup : connect}
              disabled={status === 'connecting'}
              className={`group relative px-10 py-4 rounded-full font-bold text-lg shadow-xl transition-all transform active:scale-95 ${
                status === 'connected' || status === 'connecting'
                  ? 'bg-red-50 text-red-600 border border-red-100 hover:bg-red-100'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              <span className="flex items-center space-x-3">
                {status === 'connecting' ? 'Establishing...' : status === 'connected' ? 'End Call' : 'Start Interaction'}
              </span>
            </button>

            {errorMsg && (
              <div className="max-w-xs text-center p-3 bg-red-50 text-red-600 rounded-xl text-xs font-medium border border-red-100">
                {errorMsg}
              </div>
            )}
          </div>
        </main>

        <footer className="bg-slate-50 px-8 py-6 border-t border-slate-100 text-center">
          <p className="text-slate-400 text-[11px] font-medium uppercase tracking-widest leading-relaxed">
            © 2026 Riyadah Ltd. All rights reserved. <br/>
            Hotline: (+2) 0155-155-3285 Cairo, Egypt
          </p>
        </footer>
      </div>
    </div>
  );
};

export default App;
