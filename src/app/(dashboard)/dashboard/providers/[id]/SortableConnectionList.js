"use client";

import PropTypes from "prop-types";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";

// Persist a provider's whole connection order in one request (see
// /api/providers/reorder). Returns true on success.
export async function saveConnectionOrder(provider, connections) {
  try {
    const res = await fetch("/api/providers/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, orderedIds: connections.map((c) => c.id) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function SortableItem({ id, children }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
  };
  const handle = (
    <button
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      className="cursor-grab touch-none p-1 rounded text-text-muted hover:text-primary active:cursor-grabbing"
      title="Drag to reorder"
      aria-label="Drag to reorder"
    >
      <span className="material-symbols-outlined text-[18px]">drag_indicator</span>
    </button>
  );
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "rounded-lg bg-surface shadow-md ring-1 ring-primary/30" : undefined}>
      {children(handle)}
    </div>
  );
}

SortableItem.propTypes = {
  id: PropTypes.string.isRequired,
  children: PropTypes.func.isRequired,
};

// Drag-to-reorder list of connections. `renderRow(conn, index, dragHandle)` renders
// one row; `onReorder(next)` gets the reordered array after a drop.
export default function SortableConnectionList({ connections, onReorder, renderRow, className }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Phones: a short press on the handle starts the drag, so a swipe still scrolls.
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = connections.findIndex((c) => c.id === active.id);
    const to = connections.findIndex((c) => c.id === over.id);
    if (from !== -1 && to !== -1) onReorder(arrayMove(connections, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
      <SortableContext items={connections.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {connections.map((conn, index) => (
            <SortableItem key={conn.id} id={conn.id}>
              {(handle) => renderRow(conn, index, handle)}
            </SortableItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

SortableConnectionList.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired })).isRequired,
  onReorder: PropTypes.func.isRequired,
  renderRow: PropTypes.func.isRequired,
  className: PropTypes.string,
};
