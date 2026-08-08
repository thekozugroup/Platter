/**
 * One icon set, under the names the vendored Shark components already import.
 *
 * DESIGN §6 puts the whole product on [pixelarticons](https://pixelarticons.com/): the
 * pixel-art style is the deliberate partner to the pixel display face, and "a smooth outline
 * set would fight it". The Shark registry, though, ships `lucide-react` imports inside 15 of
 * the `components/ui/*` files this app renders — chevrons on every select, the tick in every
 * checkbox, the glyphs in every toast. Left alone, the most form-heavy screens draw two icon
 * systems side by side, and the mix is the loudest "assembled from parts" signal in the UI.
 *
 * Rather than patch icons per call site (there are dozens, and every future `shadcn add`
 * would reintroduce them), the vendored files import their icons from here. Swapping the
 * module specifier is a one-line change per file and it is the only edit those files need.
 *
 * The names are lucide's on purpose. That keeps the vendored diff to the import path, so a
 * later registry update is still a clean merge.
 *
 * Two of pixelarticons' 877 React components — `SettingsCog` and `Frame` — carry a codegen
 * bug where a `<clipPath>` rect was flattened into a painted `<path>`, so they render as a
 * solid filled block. Neither is re-exported here, and neither should be imported anywhere.
 */

import { Check } from 'pixelarticons/react/Check.js';
import { ChevronLeft } from 'pixelarticons/react/ChevronLeft.js';
import { ChevronRight } from 'pixelarticons/react/ChevronRight.js';
import { ChevronsVertical } from 'pixelarticons/react/ChevronsVertical.js';
import { Close } from 'pixelarticons/react/Close.js';
import { Eye } from 'pixelarticons/react/Eye.js';
import { EyeOff } from 'pixelarticons/react/EyeOff.js';
import { InfoBox } from 'pixelarticons/react/InfoBox.js';
import { Loader } from 'pixelarticons/react/Loader.js';
import { Menu } from 'pixelarticons/react/Menu.js';
import { Minus } from 'pixelarticons/react/Minus.js';
import { MoreHorizontal } from 'pixelarticons/react/MoreHorizontal.js';
import { Search } from 'pixelarticons/react/Search.js';
import { SquareAlert } from 'pixelarticons/react/SquareAlert.js';
import { Upload } from 'pixelarticons/react/Upload.js';
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js';

export {
  Check as CheckIcon,
  ChevronLeft,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight,
  ChevronRight as ChevronRightIcon,
  ChevronsVertical as ChevronsUpDownIcon,
  Close as XIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  InfoBox as InfoIcon,
  Loader as Loader2Icon,
  Menu as PanelLeftIcon,
  Minus as MinusIcon,
  MoreHorizontal as Ellipsis,
  MoreHorizontal as MoreHorizontalIcon,
  Search as SearchIcon,
  SquareAlert as CircleAlertIcon,
  Check as CircleCheckIcon,
  Upload as UploadIcon,
  WarningDiamond as TriangleAlertIcon,
};
