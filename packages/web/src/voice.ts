// Voice input using the Web Speech API.

export class VoiceInput {
  private recognition: SpeechRecognition | null = null;

  isSupported(): boolean {
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }

  start(
    onInterim: (transcript: string) => void,
    onFinal: (transcript: string) => void,
  ): void {
    if (!this.isSupported()) return;

    const SR = (window.SpeechRecognition ?? (window as any).webkitSpeechRecognition) as typeof SpeechRecognition;
    this.recognition = new SR();
    this.recognition.lang = navigator.language;
    this.recognition.interimResults = true;
    this.recognition.continuous = false;

    this.recognition.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      if (interim) onInterim(interim);
      if (final) onFinal(final);
    };

    this.recognition.onerror = () => this.stop();
    this.recognition.start();
  }

  stop(): void {
    this.recognition?.stop();
    this.recognition = null;
  }
}
