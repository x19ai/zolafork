import { Markdown } from "@/components/prompt-kit/markdown"
import { cn } from "@/lib/utils"
import { CaretDownIcon } from "@phosphor-icons/react"
import { AnimatePresence, motion } from "framer-motion"
import { useState } from "react"

type ReasoningProps = {
  reasoning: string
  isStreaming?: boolean
}

const TRANSITION = {
  type: "spring" as const,
  duration: 0.2,
  bounce: 0,
}

export function Reasoning({ reasoning, isStreaming }: ReasoningProps) {
  const [wasStreaming, setWasStreaming] = useState(isStreaming ?? false)
  const [isExpanded, setIsExpanded] = useState(false)

  if (wasStreaming && isStreaming === false) {
    setWasStreaming(false)
    setIsExpanded(false)
  }

  // Set expanded to true when streaming starts
  if (isStreaming && !wasStreaming) {
    setWasStreaming(true)
    setIsExpanded(true)
  }

  return (
    <div>
      <button
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <span>Reasoning</span>
        <CaretDownIcon
          className={cn(
            "size-3 transition-transform",
            isExpanded ? "rotate-180" : ""
          )}
        />
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            className="mt-2 overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TRANSITION}
          >
            <div className="text-muted-foreground border-muted-foreground/20 flex flex-col border-l pl-4 text-sm">
              <Markdown>{reasoning}</Markdown>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
