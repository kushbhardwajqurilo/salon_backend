import mongoose from "mongoose";
import { connectDB } from "../database/db.js";
import { Organization } from "../models/organizations/organization.model.js";
import { Branch } from "../models/branches/branch.model.js";
import { ServiceCategory } from "../models/services/serviceCategory.model.js";
import { Service } from "../models/services/service.model.js";

export const serviceCatalog = [
  // -------------------------------------------------------------
  // Page 1: BODY POLISHING, IPL, THREADING
  // -------------------------------------------------------------
  {
    category: "Body Polishing",
    description: "Rejuvenating and skin brightening body polishing treatments",
    services: [
      { name: "Body Scrub with Pack", basePrice: 4000, duration: 60, serviceCode: "BP-SCRUB-PACK" },
      { name: "Shine & Glossy", basePrice: 5000, duration: 75, serviceCode: "BP-SHINE-GLOSS" },
    ],
  },
  {
    category: "IPL",
    description: "Intense Pulsed Light laser hair reduction treatments",
    services: [
      { name: "IPL Upper Lips", basePrice: 1500, duration: 20, serviceCode: "IPL-UPPER-LIP" },
      { name: "IPL Chin", basePrice: 1500, duration: 20, serviceCode: "IPL-CHIN" },
      { name: "IPL Side Locks", basePrice: 4000, duration: 30, serviceCode: "IPL-SIDE-LOCKS" },
      { name: "IPL Full Face with Forehead", basePrice: 6000, duration: 45, serviceCode: "IPL-FACE-W-FH" },
      { name: "IPL Full Face Without Forehead", basePrice: 5000, duration: 40, serviceCode: "IPL-FACE-WO-FH" },
      { name: "IPL Full Arms", basePrice: 7000, duration: 60, serviceCode: "IPL-FULL-ARMS" },
      { name: "IPL Under Arms", basePrice: 5000, duration: 30, serviceCode: "IPL-UNDER-ARMS" },
      { name: "IPL Full Legs", basePrice: 8500, duration: 75, serviceCode: "IPL-FULL-LEGS" },
      { name: "IPL Bikini Area", basePrice: 5000, duration: 45, serviceCode: "IPL-BIKINI" },
      { name: "IPL Full Body Without Face", basePrice: 25000, duration: 180, serviceCode: "IPL-BODY-WO-FC" },
      { name: "IPL Full Body With Face", basePrice: 30000, duration: 210, serviceCode: "IPL-BODY-W-FC" },
    ],
  },
  {
    category: "Threading",
    description: "Precise facial hair removal and brow shaping",
    services: [
      { name: "Threading Eyebrows", basePrice: 70, duration: 15, serviceCode: "THRD-EYEBROW" },
      { name: "Threading Upper Lips", basePrice: 50, duration: 10, serviceCode: "THRD-UPPERLIP" },
      { name: "Threading Forehead", basePrice: 50, duration: 10, serviceCode: "THRD-FOREHEAD" },
      { name: "Threading Side Locks", basePrice: 100, duration: 15, serviceCode: "THRD-SIDELOCK" },
      { name: "Threading Chin", basePrice: 80, duration: 10, serviceCode: "THRD-CHIN" },
      { name: "Threading Neck", basePrice: 100, duration: 15, serviceCode: "THRD-NECK" },
      { name: "Threading Full Face", basePrice: 250, duration: 35, serviceCode: "THRD-FULLFACE" },
    ],
  },

  // -------------------------------------------------------------
  // Page 2: CHOCOLATE / ALOEVERA WAX, RICA WAX
  // -------------------------------------------------------------
  {
    category: "Chocolate / Aloevera Wax",
    description: "Skin-nourishing chocolate and soothing aloe vera wax",
    services: [
      { name: "Chocolate/Aloe Arms Half", basePrice: 400, duration: 25, serviceCode: "CAW-ARMS-HLF" },
      { name: "Chocolate/Aloe Arms Full", basePrice: 500, duration: 35, serviceCode: "CAW-ARMS-FUL" },
      { name: "Chocolate/Aloe Legs Half", basePrice: 500, duration: 30, serviceCode: "CAW-LEGS-HLF" },
      { name: "Chocolate/Aloe Legs Full", basePrice: 600, duration: 45, serviceCode: "CAW-LEGS-FUL" },
      { name: "Chocolate/Aloe Full Arms with Under Arms", basePrice: 700, duration: 45, serviceCode: "CAW-ARMS-UA" },
      { name: "Chocolate/Aloe Back Half", basePrice: 1000, duration: 30, serviceCode: "CAW-BACK-HLF" },
      { name: "Chocolate/Aloe Full Back", basePrice: 1300, duration: 45, serviceCode: "CAW-BACK-FUL" },
      { name: "Chocolate/Aloe Full Body Wax", basePrice: 3000, duration: 100, serviceCode: "CAW-BODY-FUL" },
      { name: "Chocolate/Aloe Bikini Wax", basePrice: 2500, duration: 45, serviceCode: "CAW-BIKINI" },
      { name: "Chocolate/Aloe Tummy Wax", basePrice: 1000, duration: 25, serviceCode: "CAW-TUMMY" },
      { name: "Chocolate/Aloe Full Front", basePrice: 1300, duration: 45, serviceCode: "CAW-FRONT-FUL" },
      { name: "Chocolate/Aloe Under Arms", basePrice: 300, duration: 15, serviceCode: "CAW-UNDER-ARM" },
    ],
  },
  {
    category: "Rica Wax",
    description: "Colophony-free Italian liposoluble Rica waxing",
    services: [
      { name: "Rica Wax Arms Half", basePrice: 600, duration: 25, serviceCode: "RICA-ARMS-HLF" },
      { name: "Rica Wax Arms Full", basePrice: 700, duration: 35, serviceCode: "RICA-ARMS-FUL" },
      { name: "Rica Wax Legs Half", basePrice: 700, duration: 30, serviceCode: "RICA-LEGS-HLF" },
      { name: "Rica Wax Legs Full", basePrice: 800, duration: 45, serviceCode: "RICA-LEGS-FUL" },
      { name: "Rica Wax Full Arms with Under Arms", basePrice: 800, duration: 45, serviceCode: "RICA-ARMS-UA" },
      { name: "Rica Wax Back Half", basePrice: 1300, duration: 30, serviceCode: "RICA-BACK-HLF" },
      { name: "Rica Wax Full Back", basePrice: 2200, duration: 50, serviceCode: "RICA-BACK-FUL" },
      { name: "Rica Wax Full Body Wax", basePrice: 4500, duration: 120, serviceCode: "RICA-BODY-FUL" },
      { name: "Rica Wax Bikini Wax", basePrice: 2800, duration: 45, serviceCode: "RICA-BIKINI" },
      { name: "Rica Wax Tummy Wax", basePrice: 1500, duration: 30, serviceCode: "RICA-TUMMY" },
      { name: "Rica Wax Full Front", basePrice: 2200, duration: 50, serviceCode: "RICA-FRONT-FUL" },
      { name: "Rica Wax Under Arms", basePrice: 500, duration: 15, serviceCode: "RICA-UNDER-ARM" },
      { name: "Rica Wax Butt Wax", basePrice: 2500, duration: 35, serviceCode: "RICA-BUTT" },
    ],
  },

  // -------------------------------------------------------------
  // Page 3: MAKE-UP SERVICES
  // -------------------------------------------------------------
  {
    category: "Permanent Make-Up",
    description: "Micro-pigmentation and semi-permanent aesthetic makeup",
    services: [
      { name: "Permanent Eye Brows", basePrice: 15000, duration: 90, serviceCode: "PMU-EYEBROWS" },
      { name: "Permanent Kajal", basePrice: 10000, duration: 60, serviceCode: "PMU-KAJAL" },
      { name: "Permanent Eye Liner", basePrice: 10000, duration: 60, serviceCode: "PMU-EYELINER" },
      { name: "Permanent Lip Liner", basePrice: 10000, duration: 75, serviceCode: "PMU-LIPLINER" },
      { name: "Beauty Spot", basePrice: 3000, duration: 30, serviceCode: "PMU-BEAUTYSPOT" },
      { name: "Leukoderma Patches per sq.inch", basePrice: 8000, duration: 60, serviceCode: "PMU-LEUKODERMA" },
      { name: "Micro Blading", basePrice: 20000, duration: 120, serviceCode: "PMU-MICROBLADE" },
      { name: "Eyelash Extension", basePrice: 4000, duration: 90, serviceCode: "PMU-EYELASH-EXT" },
    ],
  },
  {
    category: "Flawless Make-Up",
    description: "Flawless HD makeup packages for party, engagement, and bridal",
    services: [
      { name: "Flawless HD Party Make-up", basePrice: 5000, duration: 60, serviceCode: "MK-FLW-PARTY" },
      { name: "Flawless HD Engagement Make-up", basePrice: 10000, duration: 90, serviceCode: "MK-FLW-ENGAGE" },
      { name: "Flawless HD Bridal Make-up", basePrice: 16000, duration: 150, serviceCode: "MK-FLW-BRIDAL" },
    ],
  },
  {
    category: "MAC Make-Up",
    description: "MAC premium cosmetics professional styling and makeup",
    services: [
      { name: "MAC HD Party Make-up", basePrice: 7000, duration: 60, serviceCode: "MK-MAC-PARTY" },
      { name: "MAC HD Engagement Make-up", basePrice: 13000, duration: 90, serviceCode: "MK-MAC-ENGAGE" },
      { name: "MAC HD Bridal Make-up", basePrice: 20000, duration: 150, serviceCode: "MK-MAC-BRIDAL" },
    ],
  },
  {
    category: "Air Brush Make-Up",
    description: "High-definition Airbrush makeup for long-lasting flawless finish",
    services: [
      { name: "Air Brush HD Party Make-up", basePrice: 10000, duration: 75, serviceCode: "MK-AIR-PARTY" },
      { name: "Air Brush HD Engagement Make-up", basePrice: 15000, duration: 105, serviceCode: "MK-AIR-ENGAGE" },
      { name: "Air Brush HD Bridal Make-up", basePrice: 25000, duration: 180, serviceCode: "MK-AIR-BRIDAL" },
    ],
  },
  {
    category: "Celebrity Make-Up",
    description: "Elite celebrity glam styling for party, engagement, and weddings",
    services: [
      { name: "Celebrity HD Party Make-up", basePrice: 12000, duration: 90, serviceCode: "MK-CEL-PARTY" },
      { name: "Celebrity HD Engagement Make-up", basePrice: 20000, duration: 120, serviceCode: "MK-CEL-ENGAGE" },
      { name: "Celebrity HD Bridal Make-up", basePrice: 28000, duration: 180, serviceCode: "MK-CEL-BRIDAL" },
    ],
  },
  {
    category: "Hollywood Celebrity Make-Up",
    description: "Luxury red carpet Hollywood celebrity couture makeup",
    services: [
      { name: "Hollywood Celebrity HD Party Make-up", basePrice: 15000, duration: 100, serviceCode: "MK-HW-PARTY" },
      { name: "Hollywood Celebrity HD Engagement Make-up", basePrice: 25000, duration: 130, serviceCode: "MK-HW-ENGAGE" },
      { name: "Hollywood Celebrity HD Bridal Make-up", basePrice: 35000, duration: 200, serviceCode: "MK-HW-BRIDAL" },
    ],
  },

  // -------------------------------------------------------------
  // Page 4: JOLEN / PROTEIN, REGULAR WAX
  // -------------------------------------------------------------
  {
    category: "Jolen / Protein",
    description: "Gentle herbal, protein, and Jolen skin lightening treatments",
    services: [
      { name: "Jolen/Protein Face", basePrice: 500, duration: 25, serviceCode: "JP-FACE" },
      { name: "Jolen/Protein Neck & Back (Blouse Line)", basePrice: 800, duration: 35, serviceCode: "JP-NB" },
      { name: "Jolen/Protein Full Front", basePrice: 800, duration: 40, serviceCode: "JP-FFRONT" },
      { name: "Jolen/Protein Full Back", basePrice: 800, duration: 40, serviceCode: "JP-FBACK" },
      { name: "Jolen/Protein Arms", basePrice: 800, duration: 40, serviceCode: "JP-ARMS" },
      { name: "Jolen/Protein Legs", basePrice: 1000, duration: 45, serviceCode: "JP-LEGS" },
      { name: "Jolen/Protein Body", basePrice: 3500, duration: 90, serviceCode: "JP-BODY" },
      { name: "Jolen/Protein Feet", basePrice: 600, duration: 25, serviceCode: "JP-FEET" },
    ],
  },
  {
    category: "Regular Wax",
    description: "Classic honey and sugar strip waxing",
    services: [
      { name: "Regular Wax Arms Half", basePrice: 300, duration: 25, serviceCode: "RWX-ARMS-HLF" },
      { name: "Regular Wax Arms Full", basePrice: 400, duration: 35, serviceCode: "RWX-ARMS-FUL" },
      { name: "Regular Wax Legs Half", basePrice: 400, duration: 30, serviceCode: "RWX-LEGS-HLF" },
      { name: "Regular Wax Legs Full", basePrice: 500, duration: 45, serviceCode: "RWX-LEGS-FUL" },
      { name: "Regular Wax Full Arms with Under Arms", basePrice: 500, duration: 45, serviceCode: "RWX-ARMS-UA" },
      { name: "Regular Wax Back Half", basePrice: 800, duration: 30, serviceCode: "RWX-BACK-HLF" },
      { name: "Regular Wax Full Back", basePrice: 1000, duration: 45, serviceCode: "RWX-BACK-FUL" },
      { name: "Regular Wax Full Body", basePrice: 2500, duration: 90, serviceCode: "RWX-BODY-FUL" },
      { name: "Regular Wax Bikini", basePrice: 1800, duration: 40, serviceCode: "RWX-BIKINI" },
      { name: "Regular Wax Tummy", basePrice: 800, duration: 25, serviceCode: "RWX-TUMMY" },
      { name: "Regular Wax Full Front", basePrice: 1000, duration: 45, serviceCode: "RWX-FRONT-FUL" },
      { name: "Regular Wax Under Arms", basePrice: 200, duration: 15, serviceCode: "RWX-UNDER-ARM" },
    ],
  },

  // -------------------------------------------------------------
  // Page 5: RED WAX / BRAZILIAN WAX, BLEACH OXY
  // -------------------------------------------------------------
  {
    category: "Red Wax / Brazilian Wax",
    description: "Premium sensitive skin red peel and Brazilian waxing",
    services: [
      { name: "Red Wax Upper Lips", basePrice: 150, duration: 15, serviceCode: "RW-UPPERLIP" },
      { name: "Red Wax Forehead", basePrice: 250, duration: 15, serviceCode: "RW-FOREHEAD" },
      { name: "Red Wax Chin", basePrice: 100, duration: 15, serviceCode: "RW-CHIN" },
      { name: "Red Wax Chin Large", basePrice: 150, duration: 20, serviceCode: "RW-CHIN-LRG" },
      { name: "Red Wax Chin with Neck", basePrice: 200, duration: 25, serviceCode: "RW-CHIN-NECK" },
      { name: "Red Wax Side-Lock", basePrice: 600, duration: 20, serviceCode: "RW-SIDELOCK" },
      { name: "Red Wax Full Face", basePrice: 800, duration: 40, serviceCode: "RW-FULLFACE" },
      { name: "Red Wax Full Face with Neck", basePrice: 1000, duration: 50, serviceCode: "RW-FACE-NECK" },
    ],
  },
  {
    category: "Bleach Oxy",
    description: "Oxygenating facial and body bleach treatments",
    services: [
      { name: "Bleach Oxy Face", basePrice: 600, duration: 25, serviceCode: "BL-OXY-FACE" },
      { name: "Bleach Oxy Neck & Back (Blouse Line)", basePrice: 1200, duration: 35, serviceCode: "BL-OXY-NB" },
      { name: "Bleach Oxy Full Front", basePrice: 1200, duration: 40, serviceCode: "BL-OXY-FFRONT" },
      { name: "Bleach Oxy Full Back", basePrice: 1200, duration: 40, serviceCode: "BL-OXY-FBACK" },
      { name: "Bleach Oxy Arms", basePrice: 1200, duration: 40, serviceCode: "BL-OXY-ARMS" },
      { name: "Bleach Oxy Legs", basePrice: 2000, duration: 50, serviceCode: "BL-OXY-LEGS" },
      { name: "Bleach Oxy Body", basePrice: 4500, duration: 90, serviceCode: "BL-OXY-BODY" },
      { name: "Bleach Oxy Feet", basePrice: 800, duration: 25, serviceCode: "BL-OXY-FEET" },
    ],
  },

  // -------------------------------------------------------------
  // Page 6: SKIN TREATMENT
  // -------------------------------------------------------------
  {
    category: "Skin Treatment",
    description: "Clinical skin therapy, advanced peels, galvanic, and luxury facial treatments",
    services: [
      { name: "Acne Treatment", basePrice: 2000, duration: 45, serviceCode: "SKN-ACNE-TRT" },
      { name: "Laser Treatment", basePrice: 1500, duration: 30, serviceCode: "SKN-LASER-TRT" },
      { name: "Micro Bio Lifting", basePrice: 1800, duration: 45, serviceCode: "SKN-MICRO-BIO-LFT" },
      { name: "De-Tan Galvanic Treatment", basePrice: 2500, duration: 50, serviceCode: "SKN-DETAN-GALV" },
      { name: "De-Tan Fruit Bio Peel", basePrice: 2500, duration: 45, serviceCode: "SKN-DETAN-BIOPEEL" },
      { name: "AHA Treatment", basePrice: 4500, duration: 60, serviceCode: "SKN-AHA-TRT" },
      { name: "G.A. Peel", basePrice: 3000, duration: 45, serviceCode: "SKN-GA-PEEL" },
      { name: "Under Eye Treatment", basePrice: 2000, duration: 30, serviceCode: "SKN-UNDER-EYE" },
      { name: "Young Skin Mask (Half)", basePrice: 4500, duration: 45, serviceCode: "SKN-YOUNG-MSK-HLF" },
      { name: "Young Skin Mask (Full)", basePrice: 7000, duration: 60, serviceCode: "SKN-YOUNG-MSK-FUL" },
      { name: "Photo Facial", basePrice: 4000, duration: 60, serviceCode: "SKN-PHOTO-FACIAL" },
      { name: "Photo Facial with Mask", basePrice: 6500, duration: 75, serviceCode: "SKN-PHOTO-FCL-MSK" },
      { name: "Micro Dermabrasion", basePrice: 5000, duration: 60, serviceCode: "SKN-MICRO-DERM" },
      { name: "M.A. With Mask", basePrice: 7500, duration: 75, serviceCode: "SKN-MA-WITH-MSK" },
      { name: "RRR With Mask", basePrice: 7500, duration: 75, serviceCode: "SKN-RRR-WITH-MSK" },
      { name: "RRR without Mask", basePrice: 5000, duration: 60, serviceCode: "SKN-RRR-WO-MSK" },
      { name: "Snow White F. Treatment", basePrice: 4000, duration: 60, serviceCode: "SKN-SNOW-WHITE" },
      { name: "Under Eye Bioptron", basePrice: 1200, duration: 25, serviceCode: "SKN-EYE-BIOPTRON" },
      { name: "Thermoherb with Face Lift", basePrice: 2500, duration: 60, serviceCode: "SKN-THERMOHERB-FL" },
      { name: "Casmara Facial", basePrice: 8500, duration: 90, serviceCode: "SKN-CASMARA" },
      { name: "Korean Glass Facial", basePrice: 9000, duration: 90, serviceCode: "SKN-KOREAN-GLASS" },
      { name: "Skeyndor Facial", basePrice: 15000, duration: 105, serviceCode: "SKN-SKEYNDOR" },
    ],
  },

  // -------------------------------------------------------------
  // Page 7: HAIR STYLING & BODY MASSAGE
  // -------------------------------------------------------------
  {
    category: "Hair Styling",
    description: "Professional hair styling, hot tools, curls, and updos",
    services: [
      { name: "Tongs", basePrice: 800, duration: 40, serviceCode: "HST-TONGS" },
      { name: "Roller Setting", basePrice: 550, duration: 45, serviceCode: "HST-ROLLER-SET" },
      { name: "Blow Dryer", basePrice: 400, duration: 30, serviceCode: "HST-BLOW-DRY" },
      { name: "Fall", basePrice: 1800, duration: 50, serviceCode: "HST-FALL" },
      { name: "Bun", basePrice: 550, duration: 35, serviceCode: "HST-BUN" },
      { name: "Pressing", basePrice: 600, duration: 40, serviceCode: "HST-PRESSING" },
      { name: "Split Ends", basePrice: 600, duration: 30, serviceCode: "HST-SPLIT-ENDS" },
    ],
  },
  {
    category: "Body Massage",
    description: "Holistic full body therapies, aromatic oils, scrubs and bridal uktan",
    services: [
      { name: "Regular Body Massage", basePrice: 1500, duration: 60, serviceCode: "BMS-REGULAR" },
      { name: "Full Body Massage Olive Oil", basePrice: 2500, duration: 60, serviceCode: "BMS-OLIVE-OIL" },
      { name: "Body Massage Aroma", basePrice: 2000, duration: 60, serviceCode: "BMS-AROMA" },
      { name: "Body Scrub + Pack", basePrice: 3500, duration: 75, serviceCode: "BMS-SCRUB-PACK" },
      { name: "Regular Bridal Uptan with Haldi", basePrice: 3500, duration: 90, serviceCode: "BMS-BRIDAL-UPTAN" },
    ],
  },

  // -------------------------------------------------------------
  // Page 8: HAIR COLORING, CHEMICAL JOBS, HAIR CUT
  // -------------------------------------------------------------
  {
    category: "Hair Coloring",
    description: "L'Oréal Majirel, Inoa root touch-ups, streak highlights and global hair colors",
    services: [
      { name: "Root Touch-up (Majirel)", basePrice: 2000, duration: 60, serviceCode: "HCL-ROOT-MAJ" },
      { name: "Root Touch-up (Inoa)", basePrice: 2800, duration: 60, serviceCode: "HCL-ROOT-INOA" },
      { name: "Streaks (Per Streak)", basePrice: 450, duration: 30, serviceCode: "HCL-STREAKS" },
      { name: "Global Hair Color", basePrice: 5000, duration: 120, serviceCode: "HCL-GLOBAL" },
    ],
  },
  {
    category: "Chemical Jobs",
    description: "Permanent chemical straightening, smoothing, Botox, and protein restoration",
    services: [
      { name: "Kera Smooth", basePrice: 5000, duration: 180, serviceCode: "CHM-KERA-SMOOTH" },
      { name: "Rebonding", basePrice: 5000, duration: 210, serviceCode: "CHM-REBONDING" },
      { name: "Smoothing", basePrice: 5000, duration: 180, serviceCode: "CHM-SMOOTHING" },
      { name: "Perming", basePrice: 5000, duration: 150, serviceCode: "CHM-PERMING" },
      { name: "Keratin", basePrice: 5000, duration: 180, serviceCode: "CHM-KERATIN" },
      { name: "Hair Botox", basePrice: 5000, duration: 180, serviceCode: "CHM-HAIR-BOTOX" },
      { name: "Nano Plastia", basePrice: 7000, duration: 210, serviceCode: "CHM-NANOPLASTIA" },
    ],
  },
  {
    category: "Hair Cut",
    description: "Signature hairstyling, precision cuts, trimming and redesigns",
    services: [
      { name: "Trimming", basePrice: 400, duration: 25, serviceCode: "HCT-TRIMMING" },
      { name: "Fresh Cut", basePrice: 600, duration: 40, serviceCode: "HCT-FRESHCUT" },
    ],
  },

  // -------------------------------------------------------------
  // Page 9: HAIR TREATMENT & HEAD WASH
  // -------------------------------------------------------------
  {
    category: "Hair Treatment",
    description: "Therapeutic hair restoration, scalp diagnostics, spa, and Olaplex repairs",
    services: [
      { name: "Regular Head Massage", basePrice: 400, duration: 30, serviceCode: "HTR-REG-MASSAGE" },
      { name: "Regular Head Massage (With Steam)", basePrice: 500, duration: 40, serviceCode: "HTR-MASSAGE-STM" },
      { name: "Hair Bioptron", basePrice: 650, duration: 25, serviceCode: "HTR-BIOPTRON" },
      { name: "Red Lamp", basePrice: 650, duration: 25, serviceCode: "HTR-RED-LAMP" },
      { name: "Hair Spa (Loreal)", basePrice: 1800, duration: 60, serviceCode: "HTR-SPA-LOREAL" },
      { name: "Hair Spa Treatment", basePrice: 2000, duration: 75, serviceCode: "HTR-SPA-TREATMENT" },
      { name: "Deep Conditioning", basePrice: 950, duration: 40, serviceCode: "HTR-DEEP-COND" },
      { name: "Hair Fall Treatment", basePrice: 2500, duration: 60, serviceCode: "HTR-HAIRFALL" },
      { name: "Anti-Dandruff Treatment (Loreal)", basePrice: 2500, duration: 60, serviceCode: "HTR-ANTIDANDRUFF" },
      { name: "Ozone Treatment", basePrice: 600, duration: 30, serviceCode: "HTR-OZONE" },
      { name: "QD Hair Treatment", basePrice: 4500, duration: 90, serviceCode: "HTR-QD" },
      { name: "Olaplex Treatment", basePrice: 5500, duration: 90, serviceCode: "HTR-OLAPLEX" },
    ],
  },
  {
    category: "Head Wash",
    description: "Cleansing washes, nourishing conditioners, organic henna, and blast styling",
    services: [
      { name: "Shampoo Vanya + Conditioning", basePrice: 300, duration: 25, serviceCode: "HDW-VANYA-COND" },
      { name: "Shampoo + Cond Schwarzkopf", basePrice: 350, duration: 25, serviceCode: "HDW-SCHWARZKOPF" },
      { name: "Henna Application", basePrice: 600, duration: 45, serviceCode: "HDW-HENNA" },
      { name: "Blow Dry + Head Wash + Cond (Short)", basePrice: 600, duration: 40, serviceCode: "HDW-BD-WASH-S" },
      { name: "Blow Dry + Head Wash + Cond (Long)", basePrice: 850, duration: 55, serviceCode: "HDW-BD-WASH-L" },
    ],
  },

  // -------------------------------------------------------------
  // Page 10: O3+ D-TAN, MANICURE / PEDICURE, NAIL SERVICING
  // -------------------------------------------------------------
  {
    category: "O3+ D-Tan",
    description: "Professional grade O3+ dermal brightening and tan clearance",
    services: [
      { name: "D-Tan Face (O3+)", basePrice: 1000, duration: 30, serviceCode: "ODT-FACE" },
      { name: "D-Tan Under Arms (O3+)", basePrice: 1000, duration: 25, serviceCode: "ODT-UNDER-ARMS" },
      { name: "D-Tan Front / Back (Blouse Line) (O3+)", basePrice: 1800, duration: 40, serviceCode: "ODT-FRONT-BACK" },
      { name: "D-Tan Full Body (O3+)", basePrice: 6500, duration: 90, serviceCode: "ODT-FULL-BODY" },
      { name: "D-Tan Abdomen (O3+)", basePrice: 1500, duration: 35, serviceCode: "ODT-ABDOMEN" },
      { name: "D-Tan Full Front (O3+)", basePrice: 2500, duration: 45, serviceCode: "ODT-FULL-FRONT" },
      { name: "D-Tan Full Back (O3+)", basePrice: 2500, duration: 45, serviceCode: "ODT-FULL-BACK" },
      { name: "D-Tan Full Legs (O3+)", basePrice: 2500, duration: 60, serviceCode: "ODT-FULL-LEGS" },
      { name: "D-Tan Full Arms (O3+)", basePrice: 2500, duration: 50, serviceCode: "ODT-FULL-ARMS" },
    ],
  },
  {
    category: "Manicure & Pedicure",
    description: "Pampering hand and feet treatments, exfoliations, scrubs and paraffin baths",
    services: [
      { name: "Regular Manicure", basePrice: 700, duration: 35, serviceCode: "MNP-REG-MANI" },
      { name: "Regular Pedicure", basePrice: 800, duration: 45, serviceCode: "MNP-REG-PEDI" },
      { name: "Deluxe with Elder Fl. Scrub Manicure", basePrice: 800, duration: 40, serviceCode: "MNP-DLX-MANI" },
      { name: "Deluxe with Elder Fl. Scrub Pedicure", basePrice: 1000, duration: 50, serviceCode: "MNP-DLX-PEDI" },
      { name: "Cleopatra (Rose & Milk) Manicure", basePrice: 1000, duration: 45, serviceCode: "MNP-CLEO-MANI" },
      { name: "Cleopatra (Rose & Milk) Pedicure", basePrice: 1200, duration: 60, serviceCode: "MNP-CLEO-PEDI" },
      { name: "Shine & Glossy Manicure", basePrice: 1200, duration: 50, serviceCode: "MNP-SHN-MANI" },
      { name: "Shine & Glossy Pedicure", basePrice: 1300, duration: 60, serviceCode: "MNP-SHN-PEDI" },
      { name: "Paraffin Wax Application Hands", basePrice: 400, duration: 25, serviceCode: "MNP-PARAFFIN-HND" },
      { name: "Paraffin Wax Application Feet", basePrice: 500, duration: 30, serviceCode: "MNP-PARAFFIN-FT" },
      { name: "Crystal Manicure", basePrice: 1300, duration: 50, serviceCode: "MNP-CRYS-MANI" },
      { name: "Crystal Pedicure", basePrice: 1500, duration: 60, serviceCode: "MNP-CRYS-PEDI" },
      { name: "Bubble Gum Manicure", basePrice: 1600, duration: 55, serviceCode: "MNP-BGUM-MANI" },
      { name: "Bubble Gum Pedicure", basePrice: 1600, duration: 60, serviceCode: "MNP-BGUM-PEDI" },
      { name: "Donut Manicure", basePrice: 1800, duration: 55, serviceCode: "MNP-DONUT-MANI" },
      { name: "Donut Pedicure", basePrice: 1800, duration: 60, serviceCode: "MNP-DONUT-PEDI" },
    ],
  },
  {
    category: "Nail Servicing",
    description: "Nail styling, extensions, gel paints, and custom artistic enhancements",
    services: [
      { name: "Nail Filing", basePrice: 150, duration: 15, serviceCode: "NLS-FILING" },
      { name: "Nail Paint Application", basePrice: 150, duration: 15, serviceCode: "NLS-PAINT-APP" },
      { name: "Nail Art", basePrice: 500, duration: 30, serviceCode: "NLS-ART" },
      { name: "Nail Filing + Nail Paint", basePrice: 200, duration: 20, serviceCode: "NLS-FILE-PAINT" },
      { name: "Fake Nails", basePrice: 600, duration: 35, serviceCode: "NLS-FAKE-NAILS" },
      { name: "Fake Nails + Nail Paint", basePrice: 1200, duration: 45, serviceCode: "NLS-FAKE-PAINT" },
      { name: "Permanent Nail Art", basePrice: 1000, duration: 60, serviceCode: "NLS-PERM-ART" },
      { name: "Nail Extension Regular", basePrice: 2500, duration: 90, serviceCode: "NLS-EXT-REG" },
      { name: "Nail Extension French", basePrice: 2800, duration: 105, serviceCode: "NLS-EXT-FRENCH" },
      { name: "Fake Nails with Nail Art", basePrice: 800, duration: 60, serviceCode: "NLS-FAKE-ART" },
    ],
  },

  // -------------------------------------------------------------
  // Page 11: FACIALS
  // -------------------------------------------------------------
  {
    category: "Facials",
    description: "Nutritious botanical, hydration, antioxidant, and luxury facial cures",
    services: [
      { name: "Fruit Exfoliation", basePrice: 1000, duration: 45, serviceCode: "FCL-FRUIT-EXFOL" },
      { name: "Aloe Vera Clean up", basePrice: 1000, duration: 40, serviceCode: "FCL-ALOE-CLEAN" },
      { name: "Glow Facial", basePrice: 1500, duration: 50, serviceCode: "FCL-GLOW" },
      { name: "Aloe Vera Facial", basePrice: 1500, duration: 50, serviceCode: "FCL-ALOE-FACIAL" },
      { name: "Fruit Facial", basePrice: 1500, duration: 50, serviceCode: "FCL-FRUIT-FACIAL" },
      { name: "Collagen Facial", basePrice: 2500, duration: 60, serviceCode: "FCL-COLLAGEN" },
      { name: "Shine & Glossy Facial", basePrice: 2500, duration: 60, serviceCode: "FCL-SHINE-GLOSS" },
      { name: "Gold Facial", basePrice: 2500, duration: 60, serviceCode: "FCL-GOLD" },
      { name: "Super Gold Facial", basePrice: 4500, duration: 75, serviceCode: "FCL-SUPER-GOLD" },
      { name: "Mini AHA", basePrice: 2500, duration: 45, serviceCode: "FCL-MINI-AHA" },
      { name: "O3+ Facial", basePrice: 5000, duration: 75, serviceCode: "FCL-O3-FACIAL" },
      { name: "Hydra Facial with Insta", basePrice: 3500, duration: 60, serviceCode: "FCL-HYDRA-INSTA" },
      { name: "Hydra Facial Premium", basePrice: 5500, duration: 75, serviceCode: "FCL-HYDRA-PREM" },
      { name: "Hydra Facial with Platinum", basePrice: 7500, duration: 90, serviceCode: "FCL-HYDRA-PLAT" },
      { name: "Hydra Moist Facial Therapy", basePrice: 9000, duration: 90, serviceCode: "FCL-HYDRA-MOIST" },
      { name: "Korean Rice Water Facial", basePrice: 5000, duration: 60, serviceCode: "FCL-KOREAN-RICE" },
      { name: "BB Glow Facial", basePrice: 9000, duration: 90, serviceCode: "FCL-BB-GLOW" },
      { name: "Carbon Facial", basePrice: 8000, duration: 75, serviceCode: "FCL-CARBON" },
      { name: "4 Layers Facial", basePrice: 4800, duration: 60, serviceCode: "FCL-4-LAYERS" },
    ],
  },
];

export const seedServices = async () => {
  try {
    await connectDB();
    console.log("Connected to MongoDB for service seeding...");

    // Find default or first active organization
    let org = await Organization.findOne({ isActive: true });
    if (!org) {
      org = await Organization.findOne({});
    }

    if (!org) {
      console.error("No Organization found! Please run `npm run seed` first to create the organization.");
      process.exit(1);
    }
    console.log(`Using Organization: "${org.name}" (${org._id})`);

    // Fetch branches for this organization
    const branches = await Branch.find({ organizationId: org._id, isActive: true });
    if (!branches.length) {
      console.error("No active branches found for this organization! Please run `npm run seed` first.");
      process.exit(1);
    }
    console.log(`Found ${branches.length} active branches: ${branches.map((b) => b.name).join(", ")}`);

    let totalCategoriesInsertedOrUpdated = 0;
    let totalServicesInsertedOrUpdated = 0;

    for (let cIdx = 0; cIdx < serviceCatalog.length; cIdx++) {
      const catDef = serviceCatalog[cIdx];
      // Seed category per organization (Categories have unique compound index { organizationId, name })
      let primaryCategoryDoc = await ServiceCategory.findOne({
        name: catDef.category,
        organizationId: org._id,
      });

      if (!primaryCategoryDoc) {
        primaryCategoryDoc = await ServiceCategory.create({
          name: catDef.category,
          description: catDef.description,
          displayOrder: cIdx + 1,
          organizationId: org._id,
          status: "active",
        });
        console.log(`[Created Category] "${catDef.category}" for org "${org.name}"`);
      } else {
        primaryCategoryDoc.description = catDef.description;
        primaryCategoryDoc.displayOrder = cIdx + 1;
        primaryCategoryDoc.status = "active";
        primaryCategoryDoc.isDeleted = false;
        await primaryCategoryDoc.save();
      }

      totalCategoriesInsertedOrUpdated++;

      // Seed Services under this category
      // Service model is organization-scoped with unique name & serviceCode per organization
      for (let sIdx = 0; sIdx < catDef.services.length; sIdx++) {
        const srvDef = catDef.services[sIdx];

        let serviceDoc = await Service.findOne({
          organizationId: org._id,
          name: srvDef.name,
        });

        if (!serviceDoc) {
          serviceDoc = await Service.create({
            name: srvDef.name,
            serviceCode: srvDef.serviceCode,
            description: `${srvDef.name} - ${catDef.category}`,
            categoryId: primaryCategoryDoc._id,
            duration: srvDef.duration,
            pricing: {
              basePrice: srvDef.basePrice,
            },
            status: "active",
            displayOrder: sIdx + 1,
            organizationId: org._id,
          });
          console.log(`  + [Created Service] "${srvDef.name}" - ₹${srvDef.basePrice} (${srvDef.serviceCode})`);
        } else {
          serviceDoc.serviceCode = srvDef.serviceCode;
          serviceDoc.categoryId = primaryCategoryDoc._id;
          serviceDoc.duration = srvDef.duration;
          serviceDoc.pricing = { basePrice: srvDef.basePrice };
          serviceDoc.status = "active";
          serviceDoc.isDeleted = false;
          serviceDoc.displayOrder = sIdx + 1;
          await serviceDoc.save();
          console.log(`  * [Updated Service] "${srvDef.name}" - ₹${srvDef.basePrice}`);
        }
        totalServicesInsertedOrUpdated++;
      }
    }

    console.log("\n==========================================");
    console.log("Service and Category Seeding Completed Successfully!");
    console.log(`Total Categories Processed: ${serviceCatalog.length} (across ${branches.length} branches)`);
    console.log(`Total Services Processed: ${totalServicesInsertedOrUpdated}`);
    console.log("==========================================\n");

    if (process.env.NODE_ENV !== "test") {
      process.exit(0);
    }
  } catch (error) {
    console.error("Error during service seeding:", error);
    process.exit(1);
  }
};

// If run directly
if (process.argv[1]?.endsWith("serviceSeed.js")) {
  seedServices();
}
