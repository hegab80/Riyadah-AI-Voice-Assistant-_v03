
import React from 'react';

interface VisualizerProps {
  active: boolean;
  color?: string;
}

export const Visualizer: React.FC<VisualizerProps> = ({ active, color = 'bg-blue-600' }) => {
  return (
    <div className="flex items-center justify-center space-x-1.5 h-16">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className={`${color} w-2.5 rounded-full transition-all duration-500 ease-in-out ${
            active 
              ? `animate-bounce h-12` 
              : 'h-3 opacity-20'
          }`}
          style={{ 
            animationDelay: active ? `${i * 0.15}s` : '0s',
            animationDuration: '0.8s'
          }}
        />
      ))}
    </div>
  );
};
