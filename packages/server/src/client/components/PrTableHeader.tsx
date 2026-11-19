import "./PrTableHeader.css";

// The table's column headings (design/components.md, PR list).
export function PrTableHeader() {
  return (
    <thead>
      <tr data-component="PrTableHeader">
        <th className="repo-cell" scope="col">
          Repository
        </th>
        <th className="pr-cell" scope="col">
          Pull request
        </th>
        <th className="problem-cell" scope="col">
          Status
        </th>
        <th className="event-cell" scope="col">
          Last activity
        </th>
      </tr>
    </thead>
  );
}
