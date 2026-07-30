import { posthogService } from './posthog.ts';
import VisionService, { type VisionAnalysisRequest } from './vision.ts';

interface GenerationResult {
  success: boolean;
  code?: string;
  generationTime?: number;
  prompt?: string;
  error?: string;
  visionAnalysis?: string;
  visionUsed?: boolean;
}

class CerebrasService {
  private apiKey: string;
  private baseURL: string;
  private visionService?: VisionService;

  constructor(apiKey: string, enableVision: boolean = true) {
    this.apiKey = apiKey;
    // Use a proxy to avoid CORS issues, and to keep the API key server-side.
    // In development: the Vite proxy, which forwards to the upstream API.
    // In production: the Cloudflare Worker route.
    const isLocalhost =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    this.baseURL = isLocalhost
      ? '/api/cerebras/v1/chat/completions' // Vite proxy
      : '/api/cerebras'; // Worker route

    // Initialize vision service (no API key needed, the Worker route holds it)
    if (enableVision) {
      this.visionService = new VisionService();
    }
  }

  async generateComponent(prompt: string, screenshotDataUrl?: string): Promise<GenerationResult> {
    const startTime = Date.now();
    const visionRequested = Boolean(screenshotDataUrl && this.visionService);
    let visionAnalysis: string | undefined;
    let visionUsed = false;
    let visionProcessingTime = 0;
    let visionError: string | undefined;

    try {
      // Step 1: Vision Analysis (if screenshot and vision service are available)
      if (screenshotDataUrl && this.visionService) {
        console.log('🔍 Starting vision analysis step...');
        const visionStartTime = Date.now();

        try {
          const visionRequest: VisionAnalysisRequest = {
            imageDataUrl: screenshotDataUrl,
            userPrompt: prompt,
            preferredModel: 'llama-4-maverick',
          };

          const visionResult = await this.visionService.analyzeComponent(visionRequest);
          visionProcessingTime = (Date.now() - visionStartTime) / 1000;

          if (visionResult.success && visionResult.analysis) {
            visionAnalysis = visionResult.analysis;
            visionUsed = true;
            console.log('✅ Vision analysis completed:', `${visionProcessingTime}s`);

            // Track successful vision analysis
            posthogService.track('vision_analysis_completed', {
              success: true,
              processing_time: visionProcessingTime,
              model: visionResult.model,
              analysis_length: visionResult.analysis?.length,
              tokens_used: visionResult.tokensUsed?.total,
              confidence: visionResult.confidence,
              prompt_length: prompt.length,
              timestamp: new Date().toISOString(),
            });
          } else {
            visionError = visionResult.error;
            console.warn(
              '⚠️ Vision analysis failed, proceeding without visual context:',
              visionResult.error,
            );

            // Track failed vision analysis
            posthogService.track('vision_analysis_failed', {
              success: false,
              processing_time: visionProcessingTime,
              error: visionResult.error,
              retryable: visionResult.retryable,
              prompt_length: prompt.length,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (visionError) {
          visionProcessingTime = (Date.now() - visionStartTime) / 1000;
          const errorMessage = visionError instanceof Error ? visionError.message : 'Unknown error';
          console.warn('⚠️ Vision analysis error, proceeding without visual context:', errorMessage);

          // Track vision analysis exception
          posthogService.track('vision_analysis_exception', {
            success: false,
            processing_time: visionProcessingTime,
            error: errorMessage,
            prompt_length: prompt.length,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Step 2: Code Generation with Enhanced Prompt
      const enhancedPrompt = this.createEnhancedPrompt(prompt, visionAnalysis);
      const systemPrompt = this.getESMSystemPrompt(visionUsed);

      const isLocalhost =
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

      // Only send API key for local development (Vite proxy)
      // Netlify Function uses server-side env var
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (isLocalhost) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'gpt-oss-120b', // Cerebras fast coding model
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: enhancedPrompt },
          ],
          temperature: 0.3,
          max_tokens: 20000,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Cerebras API error:', response.status, errorText);
        return {
          success: false,
          error: `API Error: ${response.status} - ${errorText}`,
        };
      }

      const data = await response.json();
      const generationTime = (Date.now() - startTime) / 1000;

      // Clean up the generated code based on format
      let code = data.choices[0].message.content;

      // Remove any markdown code blocks
      code = code.replace(/```[\w]*\n?/g, '');
      code = code.replace(/```$/g, '');

      // Always process as ESM format
      code = this.processESMCode(code);

      console.log('Generated code:', code);
      console.log('Generation metrics:', {
        time: generationTime,
        tokens: data.usage?.total_tokens,
        model: data.model,
      });

      // Track vision-enhanced generation workflow
      posthogService.track('vision_enhanced_generation_completed', {
        success: true,
        total_generation_time: generationTime,
        vision_requested: visionRequested,
        vision_used: visionUsed,
        vision_processing_time: visionProcessingTime,
        code_generation_time: generationTime - visionProcessingTime,
        prompt_length: prompt.length,
        enhanced_prompt_length: enhancedPrompt.length,
        code_length: code?.length,
        tokens_used: data.usage?.total_tokens,
        model: data.model,
        vision_analysis_available: Boolean(visionAnalysis),
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        code,
        generationTime,
        prompt,
        visionAnalysis,
        visionUsed,
      };
    } catch (error) {
      const totalTime = (Date.now() - startTime) / 1000;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Track failed generation workflow
      posthogService.track('vision_enhanced_generation_failed', {
        success: false,
        total_generation_time: totalTime,
        vision_requested: visionRequested,
        vision_used: visionUsed,
        vision_processing_time: visionProcessingTime,
        error: errorMessage,
        prompt_length: prompt.length,
        vision_error: visionError,
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        error: errorMessage,
        visionUsed,
        visionAnalysis,
      };
    }
  }

  /**
   * Create an enhanced prompt that includes vision analysis context
   */
  private createEnhancedPrompt(userPrompt: string, visionAnalysis?: string): string {
    if (!visionAnalysis) {
      return `Create a React component: ${userPrompt}`;
    }

    return `Create a React component based on the following request and visual analysis:

USER REQUEST: ${userPrompt}

VISUAL ANALYSIS OF CURRENT COMPONENT:
${visionAnalysis}

Please create an improved React component that addresses the user's request while taking into account the visual issues and recommendations identified in the analysis above.

Focus on:
1. Implementing the specific changes requested by the user
2. Addressing any visual/layout issues mentioned in the analysis
3. Following the styling and layout recommendations
4. Maintaining good UI/UX practices

The component should be a complete, working React component that incorporates both the user's requirements and the visual improvements suggested by the analysis.`;
  }

  private getESMSystemPrompt(visionEnhanced: boolean = false): string {
    const visionInstructions = visionEnhanced
      ? `
    
    VISION-ENHANCED GENERATION:
    You are working with visual analysis of an existing component. Use this analysis to:
    - Address specific visual issues identified in the analysis
    - Implement layout and styling improvements mentioned
    - Fix spacing, alignment, and color issues noted
    - Follow the specific CSS and React recommendations provided
    - Maintain visual consistency while implementing requested changes
    `
      : '';

    return `You are an expert React developer. Create a modern ES module React component.${visionInstructions}
    
    CRITICAL Requirements:
    - Use JSX syntax normally - it will be transpiled automatically
    - START with: import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
    - Import any needed hooks at the top, don't destructure later
    - Create a functional React component using modern patterns
    - Include ALL styles as inline style objects
    - Make it visually appealing with colors, spacing, and modern design
    - RESPONSIVE DESIGN: Use width: '100%' and height: '100%' for main container
    - Component must fill its container completely - NO fixed pixel dimensions
    - For canvas/threejs: use container dimensions, not fixed sizes
    - Use flexbox with flex: 1 for flexible layouts
    - For responsive canvases: Use ResizeObserver on container, NOT window resize events
    - Canvas/WebGL components MUST observe their container element for size changes
    - END with: export default YourComponentName;
    - Return ONLY the component code, no markdown, no explanations, no backticks
    
    EXTERNAL LIBRARIES:
    - For external libraries, use ES module imports with bare specifiers:
      * import * as THREE from 'three';
      * import { motion } from 'framer-motion';
      * import Chart from 'chart.js/auto';
    - NEVER use require() - this is an ES module environment
    - NEVER assume global variables like window.THREE
    - Common libraries available: three, framer-motion, chart.js, lodash, date-fns, axios
    
    FORBIDDEN:
    - NO require() statements
    - NO CommonJS syntax (module.exports)
    - NO script tags or CDN links
    - NO assuming libraries are global (window.THREE, etc)
    
    Example structure:
    import React, { useState, useEffect } from 'react';
    import * as THREE from 'three'; // if needed
    
    const MyComponent = () => {
      const [count, setCount] = useState(0);
      
      return (
        <div style={{ padding: '20px' }}>
          <h2>Count: {count}</h2>
          <button onClick={() => setCount(count + 1)}>
            Increment
          </button>
        </div>
      );
    };
    
    export default MyComponent;
    
    CANVAS/WEBGL RESPONSIVE PATTERN:
    const containerRef = useRef(null);
    
    useEffect(() => {
      const resizeObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          const { width, height } = entry.contentRect;
          // Update canvas/renderer size here
          if (renderer) renderer.setSize(width, height);
          if (camera) {
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
          }
        }
      });
      
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }
      
      return () => resizeObserver.disconnect();
    }, [renderer, camera]);
    
    // Container must use 100% width and height
    <div ref={containerRef} style={{ width: '100%', height: '100%' }} />`;
  }

  private processESMCode(code: string): string {
    let processedCode = code;
    
    // Check if the code contains JSX (looking for < followed by capital letter or lowercase HTML elements)
    const hasJSX =
      /<[A-Z]|<(div|span|button|input|form|h[1-6]|p|a|ul|li|table|tbody|tr|td|th)/g.test(processedCode);

    if (hasJSX) {
      // If JSX is present, we need to transpile it
      // For now, we'll return an error message suggesting to use React.createElement
      console.warn(
        'ESM code contains JSX which requires transpilation. Consider using React.createElement instead.',
      );

      // Attempt to auto-convert simple JSX to React.createElement
      // This is a simplified conversion and may not handle all cases
      // For production, we should use a proper JSX transformer
    }

    // Ensure the code has proper imports
    if (!processedCode.includes('import React')) {
      // Add React import at the beginning
      const hooks = [];
      if (processedCode.includes('useState')) {
        hooks.push('useState');
      }
      if (processedCode.includes('useEffect')) {
        hooks.push('useEffect');
      }
      if (processedCode.includes('useRef')) {
        hooks.push('useRef');
      }
      if (processedCode.includes('useMemo')) {
        hooks.push('useMemo');
      }
      if (processedCode.includes('useCallback')) {
        hooks.push('useCallback');
      }

      const hooksImport = hooks.length > 0 ? `, { ${hooks.join(', ')} }` : '';
      processedCode = `import React${hooksImport} from 'react';\n\n${processedCode}`;
    }

    // Ensure the code has a default export
    if (!processedCode.includes('export default')) {
      // Try to find the main component name
      const patterns = [
        /const\s+(\w+)\s*=\s*\(\)\s*=>/, // Arrow function
        /const\s+(\w+)\s*=\s*function/, // Function expression
        /function\s+(\w+)\s*\(/, // Function declaration
      ];

      for (const pattern of patterns) {
        const match = processedCode.match(pattern);
        if (match) {
          // Add export default at the end
          processedCode += `\n\nexport default ${match[1]};`;
          break;
        }
      }
    }

    // Remove any legacy Component assignment
    processedCode = processedCode.replace(/const\s+Component\s*=\s*\w+;?/g, '');

    return processedCode.trim();
  }
}

export default CerebrasService;
